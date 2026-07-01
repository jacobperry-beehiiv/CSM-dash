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
// v3 (2026-06-25): per-customer cache keyed by the canonical
// owner_email. Value now reflects "latest with ANY known contact at
// this customer," derived from the customer's hubspot_contacts + a
// domain-match clause for business domains. Patches the gap where
// emails to non-primary contacts (or HubSpot-untracked teammates at
// the same company) were invisible to the sweep. Bumping the prefix
// forces a fresh sweep so old per-email-only entries don't linger.
const CUSTOMER_CACHE_KEY_PREFIX = "csm:last-contact-gmail:v3:";
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
  targetEmails: string[],
  opts?: { forceFresh?: boolean }
): Promise<Record<string, GmailLastContactBatchEntry>> {
  const result: Record<string, GmailLastContactBatchEntry> = {};
  if (targetEmails.length === 0) return result;
  const forceFresh = opts?.forceFresh === true;

  // Dedupe (the customer book occasionally has multiple rows with the
  // same owner_email after a merge) + lower-case so cache keys align.
  const unique = Array.from(
    new Set(
      targetEmails
        .map((e) => (e ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0)
    )
  );

  // Cache-first pass — fills `result` for hits, leaves misses for
  // fanout. With `forceFresh`, treat every target as a miss so the
  // book-wide refresh button can fully re-warm the cache.
  const misses: string[] = [];
  if (forceFresh) {
    misses.push(...unique);
  } else {
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
  }

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

// --------------------------------------------------------------------- //
// Per-customer sweep — OR-matches every known contact + the customer's
// business domain(s) so emails to non-primary contacts (and HubSpot-
// untracked teammates) get surfaced. v3 cache, keyed by the canonical
// customer email (owner_email).
// --------------------------------------------------------------------- //

export interface CustomerSignals {
  /** Stable key for the cache row — the customer's canonical
   *  email (owner_email or whatever the caller treats as
   *  authoritative). When the caller has no owner_email, fall
   *  back to the workspace_id with a `workspace:` prefix to keep
   *  the keys distinguishable. */
  key: string;
  /** Specific emails to OR-match individually. Typically the union
   *  of owner_email + every hubspot_contacts[].email. */
  emails: string[];
  /** Business domains to OR-match via `from:@dom OR to:@dom`. Empty
   *  when every contact uses a free-email provider — see
   *  customerEmailSignals() for the filtering rule. */
  domains: string[];
}

export interface CustomerLastContactResult extends GmailLastContactResult {
  /** Which email the most-recent message was with — informational
   *  for the tooltip ("Last contact: david@bigcorp.com · 2d ago"). */
  matched_email: string | null;
}

export interface CustomerLastContactBatchEntry extends CustomerLastContactResult {
  cached: boolean;
}

function customerCacheKey(csmEmail: string, customerKey: string): string {
  return (
    CUSTOMER_CACHE_KEY_PREFIX +
    csmEmail.trim().toLowerCase() +
    ":" +
    customerKey.trim().toLowerCase()
  );
}

interface CustomerCachedEntry {
  date: string | null;
  subject: string | null;
  from: string | null;
  matched_email: string | null;
  /** Snapshot of the signal set we queried against — used to bust
   *  the cache when the contact list changes (a new HubSpot contact
   *  shouldn't have to wait for the 6h TTL to be visible). */
  signal_signature: string;
  fetched_at: string;
}

/** Stable string for cache-invalidation comparisons. Same email +
 *  domain set in any order produces the same signature. */
function signalSignature(signals: CustomerSignals): string {
  const e = [...signals.emails].sort();
  const d = [...signals.domains].sort();
  return JSON.stringify({ e, d });
}

async function readCustomerCache(
  csmEmail: string,
  signals: CustomerSignals
): Promise<CustomerCachedEntry | null> {
  const entry = await kvGet<Partial<CustomerCachedEntry>>(
    customerCacheKey(csmEmail, signals.key)
  );
  if (!entry) return null;
  const fetchedMs = Date.parse(entry.fetched_at ?? "");
  if (!Number.isFinite(fetchedMs)) return null;
  if (Date.now() - fetchedMs > CACHE_TTL_MS) return null;
  // Bust if the signal set changed since the cache was written —
  // a new HubSpot contact or domain is a real change and the user
  // shouldn't wait out the 6h TTL.
  const expected = signalSignature(signals);
  if (entry.signal_signature && entry.signal_signature !== expected) {
    return null;
  }
  return {
    date: entry.date ?? null,
    subject: entry.subject ?? null,
    from: entry.from ?? null,
    matched_email: entry.matched_email ?? null,
    signal_signature: entry.signal_signature ?? expected,
    fetched_at: entry.fetched_at as string,
  };
}

async function writeCustomerCache(
  csmEmail: string,
  signals: CustomerSignals,
  entry: Omit<CustomerCachedEntry, "signal_signature">
): Promise<void> {
  await kvSet(customerCacheKey(csmEmail, signals.key), {
    ...entry,
    signal_signature: signalSignature(signals),
  });
}

/**
 * Run one Gmail query that OR-matches every known signal for a
 * customer — specific contact emails + business domains — and
 * return the most-recent message.
 *
 * Builds a query like:
 *   ((from:alice@bigcorp.com OR to:alice@bigcorp.com) OR
 *    (from:bob@bigcorp.com OR to:bob@bigcorp.com) OR
 *    (from:@bigcorp.com OR to:@bigcorp.com))
 *   -in:drafts -in:chats ...
 *
 * The domain clause is the gap-filler — it catches conversations
 * with anyone at the customer's company even when that person
 * isn't in HubSpot yet.
 */
export async function lastEmailForCustomer(
  csmEmail: string,
  signals: CustomerSignals
): Promise<CustomerLastContactResult> {
  if (signals.emails.length === 0 && signals.domains.length === 0) {
    return {
      date: null,
      subject: null,
      from: null,
      matched_email: null,
      fetched_at: new Date().toISOString(),
    };
  }

  const token = await getValidAccessTokenFor(csmEmail);
  if (!token) {
    throw new Error(
      `No valid Gmail token for ${csmEmail}. Visit /settings/gmail to connect.`
    );
  }

  function escapeForGmailQuery(s: string): string {
    // Gmail rejects quotes + backslashes inside the search-operator
    // value; lower-case for cache-key consistency.
    return s.trim().toLowerCase().replace(/["\\]/g, "");
  }

  const emailClauses = signals.emails
    .map((e) => escapeForGmailQuery(e))
    .filter(Boolean)
    .map((e) => `from:${e} OR to:${e}`);
  const domainClauses = signals.domains
    .map((d) => escapeForGmailQuery(d))
    .filter(Boolean)
    .map((d) => `from:@${d} OR to:@${d}`);

  const unionClauses = [...emailClauses, ...domainClauses];
  if (unionClauses.length === 0) {
    return {
      date: null,
      subject: null,
      from: null,
      matched_email: null,
      fetched_at: new Date().toISOString(),
    };
  }
  const union = `(${unionClauses.map((c) => `(${c})`).join(" OR ")})`;
  // Same noise filters as the per-email path (drafts, chats,
  // categories, system senders) — keeps the two helpers consistent.
  const q =
    union +
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
    return {
      date: null,
      subject: null,
      from: null,
      matched_email: null,
      fetched_at,
    };
  }

  const getParams = new URLSearchParams({ format: "metadata" });
  getParams.append("metadataHeaders", "Subject");
  getParams.append("metadataHeaders", "From");
  getParams.append("metadataHeaders", "To");
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
    payload?: { headers?: Array<{ name?: string; value?: string }> };
  };
  let subject: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  for (const h of msg.payload?.headers ?? []) {
    const n = (h.name ?? "").toLowerCase();
    if (n === "subject") subject = h.value ?? null;
    else if (n === "from") from = h.value ?? null;
    else if (n === "to") to = h.value ?? null;
  }

  // Figure out WHICH known contact the matched message was with.
  // Walk the from/to headers and pick the first contact whose
  // email appears in either. Falls back to null if Gmail's match
  // came from a domain-only signal (typical when David Meltzer is
  // at the customer's domain but isn't in HubSpot).
  function pickMatchedEmail(): string | null {
    const fromLc = (from ?? "").toLowerCase();
    const toLc = (to ?? "").toLowerCase();
    for (const e of signals.emails) {
      if (fromLc.includes(e) || toLc.includes(e)) return e;
    }
    // Domain match — extract the customer-domain address from the
    // from/to header so the tooltip still tells the CSM who it was.
    const headers = `${fromLc} ${toLc}`;
    for (const d of signals.domains) {
      const re = new RegExp(`([a-z0-9._%+-]+@${d.replace(/\./g, "\\.")})`, "i");
      const m = headers.match(re);
      if (m) return m[1];
    }
    return null;
  }

  if (!msg.internalDate) {
    return {
      date: null,
      subject,
      from,
      matched_email: pickMatchedEmail(),
      fetched_at,
    };
  }
  const ms = Number(msg.internalDate);
  if (!Number.isFinite(ms)) {
    return {
      date: null,
      subject,
      from,
      matched_email: pickMatchedEmail(),
      fetched_at,
    };
  }
  return {
    date: new Date(ms).toISOString(),
    subject,
    from,
    matched_email: pickMatchedEmail(),
    fetched_at,
  };
}

/** Cache-aware single-customer lookup. */
export async function lastEmailForCustomerCached(
  csmEmail: string,
  signals: CustomerSignals,
  opts?: { forceFresh?: boolean }
): Promise<CustomerLastContactBatchEntry> {
  if (!opts?.forceFresh) {
    const cached = await readCustomerCache(csmEmail, signals);
    if (cached) {
      return {
        date: cached.date,
        subject: cached.subject,
        from: cached.from,
        matched_email: cached.matched_email,
        fetched_at: cached.fetched_at,
        cached: true,
      };
    }
  }
  const fresh = await lastEmailForCustomer(csmEmail, signals);
  await writeCustomerCache(csmEmail, signals, {
    date: fresh.date,
    subject: fresh.subject,
    from: fresh.from,
    matched_email: fresh.matched_email,
    fetched_at: fresh.fetched_at,
  });
  return {
    date: fresh.date,
    subject: fresh.subject,
    from: fresh.from,
    matched_email: fresh.matched_email,
    fetched_at: fresh.fetched_at,
    cached: false,
  };
}

/**
 * Batch wrapper for per-customer lookups. Returns one entry per
 * customer keyed by `signals.key` (typically owner_email). Same
 * concurrency + scope-error semantics as `lastEmailWithBatch`.
 */
export async function lastEmailForCustomerBatch(
  csmEmail: string,
  customers: CustomerSignals[],
  opts?: { forceFresh?: boolean }
): Promise<Record<string, CustomerLastContactBatchEntry>> {
  const result: Record<string, CustomerLastContactBatchEntry> = {};
  if (customers.length === 0) return result;

  // Dedupe by key (customers with overlapping owner_emails / shared
  // signal sets shouldn't run twice).
  const seen = new Set<string>();
  const work = customers.filter((c) => {
    const k = c.key.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let cursor = 0;
  let scopeError: GmailReadScopeError | null = null;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= work.length) return;
      const c = work[i];
      try {
        const entry = await lastEmailForCustomerCached(csmEmail, c, opts);
        result[c.key.trim().toLowerCase()] = entry;
      } catch (e) {
        if (e instanceof GmailReadScopeError) {
          scopeError = e;
          cursor = work.length;
          return;
        }
        console.warn("[gmail-read] lastEmailForCustomer failed", {
          csmEmail,
          customerKey: c.key,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, work.length) }, () => worker())
  );
  if (scopeError) throw scopeError;
  return result;
}

// ─── Full-body message fetch ────────────────────────────────────── //
//
// The other helpers in this file call gmail.users.messages.get with
// format=metadata because last-contact only needs headers. The
// Sybill ingest path (and future similar email parsers) needs the
// rendered body — both HTML and plain-text are common — so this
// helper does the format=full variant + walks the MIME tree.
//
// Gmail returns message bodies base64url-encoded. multipart messages
// nest the actual content one or two levels deep under `payload.parts`;
// we walk recursively, decoding the first text/html and text/plain
// parts we find. Returns the raw decoded strings plus Gmail's
// `snippet` as a fallback for parsers that only need a preview.
// ──────────────────────────────────────────────────────────────────── //

export interface GmailMessageBody {
  html: string | null;
  text: string | null;
  /** Gmail's auto-extracted preview. Always populated when the
   *  message exists; useful when html/text decoding fails. */
  snippet: string | null;
  /** Subject header — convenient since parsers usually need it too. */
  subject: string | null;
  /** From header. */
  from: string | null;
  /** ISO of Gmail's internalDate. */
  internal_date: string | null;
}

function base64UrlDecode(s: string): string | null {
  try {
    // Gmail's base64url: '-' / '_' replace '+' / '/' and padding is
    // stripped. Restore for Buffer to consume.
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
  headers?: Array<{ name?: string; value?: string }>;
}

/** Walk the MIME tree picking the first text/html and text/plain parts.
 *  Gmail nests multipart/alternative inside multipart/mixed for
 *  emails with attachments, so the recursion is mandatory. */
function pickBodyParts(part: GmailMessagePart | undefined): {
  html: string | null;
  text: string | null;
} {
  let html: string | null = null;
  let text: string | null = null;
  function walk(p: GmailMessagePart | undefined): void {
    if (!p) return;
    const mime = (p.mimeType ?? "").toLowerCase();
    const data = p.body?.data;
    if (mime === "text/html" && !html && typeof data === "string") {
      html = base64UrlDecode(data);
    } else if (mime === "text/plain" && !text && typeof data === "string") {
      text = base64UrlDecode(data);
    }
    for (const child of p.parts ?? []) walk(child);
  }
  walk(part);
  return { html, text };
}

/**
 * Pull a single Gmail message in full. Pairs the body with the
 * Subject / From headers and Gmail's snippet so parsers don't need
 * a second metadata round-trip.
 *
 * Throws `GmailReadScopeError` when the token lacks gmail.readonly
 * (same error type as the other helpers in this file so the
 * "Reconnect Gmail" banner path triggers consistently).
 */
export async function fetchMessageBody(
  csmEmail: string,
  messageId: string
): Promise<GmailMessageBody> {
  const token = await getValidAccessTokenFor(csmEmail);
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/` +
    encodeURIComponent(messageId) +
    `?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new GmailReadScopeError(
      `Gmail messages.get ${res.status}: ${body.slice(0, 200)}`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gmail messages.get failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const msg = (await res.json()) as {
    snippet?: string;
    internalDate?: string;
    payload?: GmailMessagePart;
  };
  const { html, text } = pickBodyParts(msg.payload);
  let subject: string | null = null;
  let from: string | null = null;
  for (const h of msg.payload?.headers ?? []) {
    const name = (h.name ?? "").toLowerCase();
    if (name === "subject" && typeof h.value === "string") subject = h.value;
    else if (name === "from" && typeof h.value === "string") from = h.value;
  }
  let internal_date: string | null = null;
  if (msg.internalDate) {
    const ms = Number(msg.internalDate);
    if (Number.isFinite(ms)) internal_date = new Date(ms).toISOString();
  }
  return {
    html,
    text,
    snippet: typeof msg.snippet === "string" ? msg.snippet : null,
    subject,
    from,
    internal_date,
  };
}

/**
 * Thin wrapper around `users.messages.list` for the Sybill ingest
 * path. Returns just the message IDs matching `query`, capped at
 * `maxResults`. Other callers use lastEmailWith / lastEmailForCustomer
 * which build a richer query internally; this exposes the raw search
 * primitive so the Sybill sweep can pass `from:@sybill.ai newer_than:30d`.
 */
export async function listMessageIds(
  csmEmail: string,
  query: string,
  maxResults = 50
): Promise<string[]> {
  const token = await getValidAccessTokenFor(csmEmail);
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new GmailReadScopeError(
      `Gmail messages.list ${res.status}: ${body.slice(0, 200)}`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gmail messages.list failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const j = (await res.json()) as { messages?: Array<{ id?: string }> };
  const out: string[] = [];
  for (const m of j.messages ?? []) {
    if (typeof m.id === "string" && m.id) out.push(m.id);
  }
  return out;
}
