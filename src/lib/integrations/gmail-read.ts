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
  /** Subject of the matching message, for the tooltip on the detail
   *  panel. Lets a CSM eyeball "wait, an OOO auto-reply lit up
   *  today?" and re-categorize their workflow accordingly. */
  subject: string | null;
  /** Gmail's `from` header for the matching message — so we can see
   *  whether the match was outbound (CSM → contact), inbound
   *  (contact → CSM), or some forwarded weirdness. */
  from: string | null;
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

// v2 bump (2026-06-08): tightened the Gmail noise filter (excludes
// drafts, chats, scheduled sends, calendar-invite/HubSpot/Intercom
// system senders). Bumping the prefix forces a full re-fetch so
// already-cached "today" entries from the v1 query get invalidated
// instead of lingering for 6h.
const CACHE_KEY_PREFIX = "csm:last-contact-gmail:v2:";
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
  subject: string | null;
  from: string | null;
  fetched_at: string;
}

async function readCache(
  csmEmail: string,
  targetEmail: string
): Promise<CachedEntry | null> {
  const entry = await kvGet<Partial<CachedEntry>>(
    cacheKeyFor(csmEmail, targetEmail)
  );
  if (!entry) return null;
  // TTL enforced on read since KV doesn't expire keys for us.
  const fetchedMs = Date.parse(entry.fetched_at ?? "");
  if (!Number.isFinite(fetchedMs)) return null;
  if (Date.now() - fetchedMs > CACHE_TTL_MS) return null;
  // Backwards-compat: cached entries written before subject/from were
  // added carry only { date, fetched_at }. Normalize missing fields
  // to null so consumers don't have to deal with undefined.
  return {
    date: entry.date ?? null,
    subject: entry.subject ?? null,
    from: entry.from ?? null,
    fetched_at: entry.fetched_at as string,
  };
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
  //
  // Filter out noise that's been making "today" defaults appear for
  // accounts CSMs haven't actually emailed in weeks:
  //   - category:promotions / social / updates / forums — newsletters,
  //     drip campaigns, social pings.
  //   - bounce-back / OOO senders (mailer-daemon, postmaster).
  //   - no-reply addresses (transactional notifications).
  // Gmail's `-operator` syntax excludes matches. The OR before the
  // filters means the noise filters apply to the union (from OR to)
  // — parentheses make that explicit so a future tweak doesn't shift
  // operator precedence.
  const safe = targetEmail.trim().toLowerCase().replace(/["\\]/g, "");
  // Compose the query in pieces so it's legible. Key categories of
  // noise we've seen light up "today" for accounts CSMs haven't
  // actually emailed:
  //
  //   1. Drafts. Gmail's `from:` matches messages in the Drafts
  //      label by default — a half-written reply sitting in drafts
  //      becomes the "most recent message." `-in:drafts` fixes this.
  //   2. Chats. Hangouts/Chat history surfaces here as separate
  //      messages with the same from/to fields. `-in:chats`.
  //   3. Scheduled sends. Messages queued for later sit in Scheduled
  //      and match. `-in:scheduled`.
  //   4. Category filters (promotions/social/updates/forums). Cuts
  //      newsletters + transactional/system mail Google has already
  //      labeled.
  //   5. System senders Gmail doesn't always category-label:
  //      - mailer-daemon/postmaster: bounces/NDRs.
  //      - noreply/no-reply/notifications: transactional alerts.
  //      - calendar-notification: invite responses (accept/decline
  //        often comes through as a normal-looking email).
  //      - hubspot/intercom/zapier subdomains: third-party automation
  //        masquerading as the customer's domain (HubSpot's "you've
  //        been mentioned" emails were a known culprit).
  //
  // Gmail's `-operator` syntax excludes matches. Parentheses around
  // the `(from:X OR to:X)` keep the precedence explicit so the noise
  // filters apply to the union, not just the `to:` half.
  const q =
    `(from:${safe} OR to:${safe})` +
    ` -in:drafts -in:chats -in:scheduled` +
    ` -category:promotions -category:social -category:updates -category:forums` +
    ` -from:mailer-daemon -from:postmaster` +
    ` -from:noreply -from:no-reply -from:notifications` +
    ` -from:calendar-notification@google.com` +
    ` -from:notifications@hubspot.com -from:notifications@github.com` +
    ` -from:noreply@intercom.io -from:notify@intercom.io` +
    ` -from:notifications@zapier.com`;
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
    return { date: null, subject: null, from: null, fetched_at };
  }

  // Pull internalDate + Subject + From headers. format=metadata is
  // smaller than format=full but still gives us enough header data to
  // show "matched: <subject>" in the detail panel tooltip — invaluable
  // for debugging why a date looks wrong ("oh, an OOO auto-reply
  // bumped today").
  const getParams = new URLSearchParams({
    format: "metadata",
  });
  getParams.append("metadataHeaders", "Subject");
  getParams.append("metadataHeaders", "From");
  const getUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/` +
    encodeURIComponent(firstId) +
    `?${getParams.toString()}`;
  const getRes = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) {
    const body = await getRes.text().catch(() => "");
    throw new Error(
      `Gmail messages.get failed (${getRes.status}): ${body.slice(0, 200)}`
    );
  }
  const msg = (await getRes.json()) as {
    internalDate?: string;
    payload?: {
      headers?: Array<{ name?: string; value?: string }>;
    };
  };
  let subject: string | null = null;
  let from: string | null = null;
  for (const h of msg.payload?.headers ?? []) {
    const name = (h.name ?? "").toLowerCase();
    if (name === "subject" && typeof h.value === "string") {
      subject = h.value;
    } else if (name === "from" && typeof h.value === "string") {
      from = h.value;
    }
  }
  if (!msg.internalDate) {
    return { date: null, subject, from, fetched_at };
  }
  // Gmail returns internalDate as a string of epoch milliseconds.
  const ms = Number(msg.internalDate);
  if (!Number.isFinite(ms)) {
    return { date: null, subject, from, fetched_at };
  }
  return {
    date: new Date(ms).toISOString(),
    subject,
    from,
    fetched_at,
  };
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
      return {
        date: cached.date,
        subject: cached.subject,
        from: cached.from,
        fetched_at: cached.fetched_at,
        cached: true,
      };
    }
  }
  const fresh = await lastEmailWith(csmEmail, targetEmail);
  await writeCache(csmEmail, targetEmail, fresh);
  return {
    date: fresh.date,
    subject: fresh.subject,
    from: fresh.from,
    fetched_at: fresh.fetched_at,
    cached: false,
  };
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
          subject: cached.subject,
          from: cached.from,
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
          subject: fresh.subject,
          from: fresh.from,
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
