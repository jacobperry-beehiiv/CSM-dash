import { kvGet, kvSet } from "../storage/kv";
import { getValidAccessTokenFor } from "../data/gmail-token";

/**
 * Gmail-direct "last contacted" lookups for the active CSM.
 *
 * Each CSM connects their own Gmail via /api/auth/google/* and grants
 * the `gmail.readonly` scope. We query their mailbox for the most-
 * recent message exchanged with a given target email — same
 * "from:X OR to:X" search a CSM would type into Gmail manually — and
 * return that message's `internalDate` as an ISO string.
 *
 * Results are cached per (csm_email, target_email) in KV with a 6h
 * TTL so the dashboard pages can call the batch endpoint on every
 * /csm or at-risk render without re-hitting Gmail every time.
 *
 * "GmailReadScopeError" is a distinct error class so the calling
 * route can return a 403 with `needs_reconsent: true` instead of a
 * generic 500. The dashboard UI shows a "Reconnect Gmail" banner on
 * that response.
 */

export interface GmailLastContactResult {
  /** ISO string of the most-recent message's internalDate, or null
   *  when the active CSM has never emailed (or been emailed by) the
   *  target. */
  date: string | null;
  /** ISO timestamp of when we ran the Gmail query. Helps the UI show
   *  "as of 2 hours ago" when the cache served a stale-ish value. */
  fetched_at: string;
}

export interface GmailLastContactBatchEntry extends GmailLastContactResult {
  /** True when the value came from the KV cache. */
  cached: boolean;
}

export class GmailReadScopeError extends Error {
  constructor(message = "Gmail token lacks the gmail.readonly scope") {
    super(message);
    this.name = "GmailReadScopeError";
  }
}

const CACHE_KEY_PREFIX = "csm:last-contact-gmail:v1:";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Cap on parallel Gmail calls inside one batch. Gmail's per-user
 *  quota is 250 req/sec; 8 in flight + ~250ms per call leaves plenty
 *  of headroom for short bursts without tripping throttling. */
const CONCURRENCY = 8;

function cacheKeyFor(csmEmail: string, targetEmail: string): string {
  return (
    CACHE_KEY_PREFIX +
    csmEmail.trim().toLowerCase() +
    ":" +
    targetEmail.trim().toLowerCase()
  );
}

interface CachedEntry {
  date: string | null;
  fetched_at: string;
}

async function readCache(
  csmEmail: string,
  targetEmail: string
): Promise<CachedEntry | null> {
  const entry = await kvGet<CachedEntry>(cacheKeyFor(csmEmail, targetEmail));
  if (!entry) return null;
  // TTL enforced on read since KV doesn't expire keys for us.
  const fetchedMs = Date.parse(entry.fetched_at);
  if (!Number.isFinite(fetchedMs)) return null;
  if (Date.now() - fetchedMs > CACHE_TTL_MS) return null;
  return entry;
}

async function writeCache(
  csmEmail: string,
  targetEmail: string,
  entry: CachedEntry
): Promise<void> {
  await kvSet(cacheKeyFor(csmEmail, targetEmail), entry);
}

/**
 * Fetch the most-recent Gmail message between `csmEmail` (the active
 * CSM, whose token we use) and `targetEmail`. Returns null when there
 * is no such message.
 *
 * The Gmail API `users.messages.list` returns matching message IDs
 * but no payload — we then have to call `users.messages.get` on the
 * first ID to read its `internalDate`. Two API calls per lookup, but
 * the second one uses `format=minimal` so it's a small response.
 *
 * Throws GmailReadScopeError when the token has no gmail.readonly
 * scope (Gmail returns 403 with a recognizable error message). The
 * caller should surface a "needs_reconsent" path to the UI.
 */
export async function lastEmailWith(
  csmEmail: string,
  targetEmail: string
): Promise<GmailLastContactResult> {
  const token = await getValidAccessTokenFor(csmEmail);
  if (!token) {
    throw new Error(
      `No valid Gmail token for ${csmEmail}. Visit /settings/gmail to connect.`
    );
  }

  // Build a safe Gmail query string. The target email is included in
  // both `from:` and `to:` so we catch outbound AND inbound. We don't
  // bother with `newer_than:` filters — sorting by Gmail's default
  // (descending date) + maxResults=1 already gives us the latest.
  // Escape any colon / quote chars defensively so a pathological
  // email can't break the query.
  const safe = targetEmail.trim().toLowerCase().replace(/["\\]/g, "");
  const q = `from:${safe} OR to:${safe}`;
  const listUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
    `?q=${encodeURIComponent(q)}&maxResults=1`;

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => "");
    if (
      listRes.status === 403 &&
      /insufficient.*scope|metadata.*scope|read.*scope/i.test(body)
    ) {
      throw new GmailReadScopeError(
        `Gmail rejected list call as insufficient scope: ${body.slice(0, 200)}`
      );
    }
    throw new Error(
      `Gmail messages.list failed (${listRes.status}): ${body.slice(0, 200)}`
    );
  }
  const list = (await listRes.json()) as {
    messages?: Array<{ id?: string }>;
  };
  const firstId = list.messages?.[0]?.id;
  const fetched_at = new Date().toISOString();
  if (!firstId) {
    return { date: null, fetched_at };
  }

  // Pull just the internalDate; format=minimal keeps the payload tiny.
  const getUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/` +
    encodeURIComponent(firstId) +
    `?format=minimal`;
  const getRes = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) {
    const body = await getRes.text().catch(() => "");
    throw new Error(
      `Gmail messages.get failed (${getRes.status}): ${body.slice(0, 200)}`
    );
  }
  const msg = (await getRes.json()) as { internalDate?: string };
  if (!msg.internalDate) {
    return { date: null, fetched_at };
  }
  // Gmail returns internalDate as a string of epoch milliseconds.
  const ms = Number(msg.internalDate);
  if (!Number.isFinite(ms)) {
    return { date: null, fetched_at };
  }
  return { date: new Date(ms).toISOString(), fetched_at };
}

/**
 * Cache-aware single-email lookup. Reads the KV cache first; on miss
 * runs the live Gmail query and writes the result back.
 *
 * `forceFresh` bypasses the cache (used by the per-row "🔄 Refresh
 * from Gmail" button so a CSM can pull a brand-new value mid-session).
 */
export async function lastEmailWithCached(
  csmEmail: string,
  targetEmail: string,
  opts?: { forceFresh?: boolean }
): Promise<GmailLastContactBatchEntry> {
  if (!opts?.forceFresh) {
    const cached = await readCache(csmEmail, targetEmail);
    if (cached) {
      return { date: cached.date, fetched_at: cached.fetched_at, cached: true };
    }
  }
  const fresh = await lastEmailWith(csmEmail, targetEmail);
  await writeCache(csmEmail, targetEmail, fresh);
  return { date: fresh.date, fetched_at: fresh.fetched_at, cached: false };
}

/**
 * Batch wrapper. Walks the input list, serves cache hits immediately,
 * fans out parallel Gmail queries (concurrency-capped) for the misses,
 * writes results to cache, and returns a map keyed by target email.
 *
 * Throws GmailReadScopeError on the FIRST scope failure — propagating
 * out so the route can return 403 + `needs_reconsent: true` instead
 * of returning a half-populated map.
 */
export async function lastEmailWithBatch(
  csmEmail: string,
  targetEmails: string[]
): Promise<Record<string, GmailLastContactBatchEntry>> {
  const result: Record<string, GmailLastContactBatchEntry> = {};
  if (targetEmails.length === 0) return result;

  // Dedupe (the customer book occasionally has multiple rows with the
  // same owner_email after a merge) + lower-case so cache keys align.
  const unique = Array.from(
    new Set(
      targetEmails
        .map((e) => (e ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0)
    )
  );

  // Cache-first pass — fills `result` for hits, leaves misses for fanout.
  const misses: string[] = [];
  await Promise.all(
    unique.map(async (target) => {
      const cached = await readCache(csmEmail, target);
      if (cached) {
        result[target] = {
          date: cached.date,
          fetched_at: cached.fetched_at,
          cached: true,
        };
      } else {
        misses.push(target);
      }
    })
  );

  if (misses.length === 0) return result;

  // Bounded-concurrency fanout for the misses. mapConcurrent pattern
  // matches the one in src/components/am/copy-pub-ids-button.tsx but
  // is inlined here to avoid a client-component import on the server.
  let cursor = 0;
  let scopeError: GmailReadScopeError | null = null;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= misses.length) return;
      const target = misses[i];
      try {
        const fresh = await lastEmailWith(csmEmail, target);
        await writeCache(csmEmail, target, fresh);
        result[target] = {
          date: fresh.date,
          fetched_at: fresh.fetched_at,
          cached: false,
        };
      } catch (e) {
        if (e instanceof GmailReadScopeError) {
          // Capture and bail — the whole batch fails on a scope
          // problem, since every subsequent call would hit the same
          // error.
          scopeError = e;
          cursor = misses.length; // short-circuit other workers
          return;
        }
        // Per-target failures (network blip, malformed email) are
        // logged but don't abort the batch. We leave that target
        // out of the result map; the caller renders the HubSpot
        // value as the fallback.
        console.warn("[gmail-read] lastEmailWith failed", {
          csmEmail,
          target,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, misses.length) }, () => worker())
  );
  if (scopeError) throw scopeError;
  return result;
}
