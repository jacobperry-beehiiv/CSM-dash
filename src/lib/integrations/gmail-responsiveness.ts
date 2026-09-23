import { kvGet, kvSet } from "../storage/kv";
import { getValidAccessTokenFor } from "../data/gmail-token";
import {
  GmailReadScopeError,
  type CustomerSignals,
} from "./gmail-read";

/**
 * "Responsive to outreach" — the Risk Level Definitions criterion
 * that last-contact alone can't answer.
 *
 * Flag H tells us WHEN the CSM last exchanged mail with a customer.
 * It can't distinguish these two very different accounts:
 *
 *   A) CSM emailed 3 days ago, customer replied the same day.
 *   B) CSM emailed 3 days ago — and four times before that — and the
 *      customer hasn't written back since June.
 *
 * Both look identically "fresh" on a last-contact timestamp. Only the
 * second is a risk signal, and it's the one the risk doc means by
 * "responsive to outreach" / "unresponsive to CS".
 *
 * The measurement that captures it is the **unanswered-outbound
 * streak**: how many times we've written since the customer last
 * wrote to us. "Four emails since they last replied (Jun 14)" is a
 * self-explanatory sentence a CSM can act on without knowing anything
 * about how it was computed.
 *
 * Two Gmail queries per customer, both scoped to the ASSIGNED CSM's
 * token (same posture as Flag H — responsiveness to *their* CSM is
 * what matters, not to whoever happens to be viewing):
 *
 *   inbound  — `from:` the customer's emails/domains
 *   outbound — `in:sent` + `to:` the customer's emails/domains,
 *              restricted to `after:` the last inbound date
 *
 * The `after:` restriction means the outbound query only counts what
 * went unanswered, so the count is the streak directly rather than
 * something we post-process.
 */

/** Outbound messages we bother counting past the last inbound. Ten
 *  unanswered emails and forty are the same conversation — both mean
 *  "they have stopped replying" — so we cap the page and report
 *  `capped` rather than paginating a number nobody reads. */
const UNANSWERED_CAP = 10;

/** Streak at which we call it. Two unanswered emails is a busy month;
 *  three is a pattern. Deliberately a constant rather than a settings
 *  field — if it turns out to need tuning per-CSM that's a signal the
 *  metric is wrong, not that it needs a knob. */
const UNRESPONSIVE_THRESHOLD = 3;

const CACHE_KEY_PREFIX = "csm:gmail-responsiveness:v1:";
/** Matches the last-contact cache. Gmail rate limits are the real
 *  constraint and this data changes on the same cadence. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type ResponsivenessStatus =
  /** No outbound mail from this CSM to this customer, ever. We've
   *  never asked, so responsiveness is unmeasured — NOT bad. */
  | "no_outreach"
  /** Zero unanswered outbound: either they replied to our last note,
   *  or the last word in the thread was theirs. */
  | "responsive"
  /** One or two outbound since their last reply. Normal for an active
   *  thread; worth seeing, not worth alarm. */
  | "slow"
  /** Three or more unanswered. This is the risk signal. */
  | "unresponsive";

export interface ResponsivenessResult {
  status: ResponsivenessStatus;
  /** Most recent message FROM the customer. Null when they've never
   *  written to this CSM. */
  last_inbound_at: string | null;
  last_inbound_from: string | null;
  /** Most recent message the CSM sent TO the customer. */
  last_outbound_at: string | null;
  /** Outbound messages sent after `last_inbound_at` — the streak.
   *  When `last_inbound_at` is null this counts all outbound, i.e.
   *  "we've written N times and they have never once replied". */
  unanswered_outbound: number;
  /** True when the real streak is longer than UNANSWERED_CAP. */
  unanswered_capped: boolean;
  /** Whole days since the customer last wrote. Null when never. */
  days_since_inbound: number | null;
  fetched_at: string;
}

export interface ResponsivenessBatchEntry extends ResponsivenessResult {
  cached: boolean;
}

/** Shared noise filters. Kept byte-identical to gmail-read.ts's list
 *  so the two surfaces can't disagree about whether a given automated
 *  sender counts as contact. */
const NOISE_FILTERS =
  ` -in:drafts -in:chats -in:scheduled` +
  ` -category:promotions -category:social -category:updates -category:forums` +
  ` -from:mailer-daemon -from:postmaster` +
  ` -from:noreply -from:no-reply -from:notifications` +
  ` -from:calendar-notification@google.com` +
  ` -from:notifications@hubspot.com -from:notifications@github.com` +
  ` -from:noreply@intercom.io -from:notify@intercom.io` +
  ` -from:notifications@zapier.com`;

function escapeForGmailQuery(s: string): string {
  return s.trim().toLowerCase().replace(/["\\]/g, "");
}

/** Build the OR-union of `<op>:<value>` clauses for a customer's
 *  emails + domains. `op` is "from" or "to" — that single swap is
 *  what makes the query directional. */
function directionalUnion(
  signals: CustomerSignals,
  op: "from" | "to"
): string | null {
  const clauses = [
    ...signals.emails.map((e) => escapeForGmailQuery(e)).filter(Boolean).map((e) => `${op}:${e}`),
    ...signals.domains.map((d) => escapeForGmailQuery(d)).filter(Boolean).map((d) => `${op}:@${d}`),
  ];
  if (clauses.length === 0) return null;
  return `(${clauses.map((c) => `(${c})`).join(" OR ")})`;
}

async function gmailList(
  token: string,
  q: string,
  maxResults: number
): Promise<{ ids: string[] }> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
    `?q=${encodeURIComponent(q)}&maxResults=${maxResults}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (
      res.status === 403 &&
      /insufficient.*scope|metadata.*scope|read.*scope/i.test(body)
    ) {
      throw new GmailReadScopeError(
        `Gmail rejected list call as insufficient scope: ${body.slice(0, 200)}`
      );
    }
    throw new Error(
      `Gmail messages.list failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as {
    messages?: Array<{ id?: string }>;
  };
  return {
    ids: (json.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)),
  };
}

/** internalDate + From for one message. `format=metadata` keeps the
 *  response small — we never need the body here. */
async function messageMeta(
  token: string,
  id: string
): Promise<{ internalDate: string | null; from: string | null }> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Date`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gmail messages.get failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as {
    internalDate?: string;
    payload?: { headers?: Array<{ name?: string; value?: string }> };
  };
  const headers = json.payload?.headers ?? [];
  const from =
    headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? null;
  const internalDate = json.internalDate
    ? new Date(Number.parseInt(json.internalDate, 10)).toISOString()
    : null;
  return { internalDate, from };
}

function deriveStatus(
  hasOutbound: boolean,
  unanswered: number
): ResponsivenessStatus {
  if (!hasOutbound) return "no_outreach";
  if (unanswered === 0) return "responsive";
  if (unanswered >= UNRESPONSIVE_THRESHOLD) return "unresponsive";
  return "slow";
}

function emptyResult(): ResponsivenessResult {
  return {
    status: "no_outreach",
    last_inbound_at: null,
    last_inbound_from: null,
    last_outbound_at: null,
    unanswered_outbound: 0,
    unanswered_capped: false,
    days_since_inbound: null,
    fetched_at: new Date().toISOString(),
  };
}

export async function responsivenessForCustomer(
  csmEmail: string,
  signals: CustomerSignals
): Promise<ResponsivenessResult> {
  const inboundUnion = directionalUnion(signals, "from");
  const outboundUnion = directionalUnion(signals, "to");
  if (!inboundUnion || !outboundUnion) return emptyResult();

  const token = await getValidAccessTokenFor(csmEmail);
  if (!token) {
    throw new Error(
      `No valid Gmail token for ${csmEmail}. Visit /settings/gmail to connect.`
    );
  }

  // 1. Most recent inbound (customer → CSM).
  const inboundQ = inboundUnion + NOISE_FILTERS;
  const inbound = await gmailList(token, inboundQ, 1);
  let lastInboundAt: string | null = null;
  let lastInboundFrom: string | null = null;
  if (inbound.ids.length > 0) {
    const meta = await messageMeta(token, inbound.ids[0]);
    lastInboundAt = meta.internalDate;
    lastInboundFrom = meta.from;
  }

  // 2. Outbound since that inbound. `in:sent` restricts to mail this
  //    CSM actually sent; `after:` makes the result set BE the
  //    unanswered streak rather than something we filter afterwards.
  //
  //    Gmail's `after:` takes a date, not a timestamp, and is
  //    inclusive of that day — so a reply and a follow-up on the same
  //    day both land in range. That biases the count UP by at most
  //    one, which is the safe direction: it can make us look slightly
  //    less responsive, never more.
  let outboundQ = `in:sent ` + outboundUnion + NOISE_FILTERS;
  if (lastInboundAt) {
    outboundQ += ` after:${lastInboundAt.slice(0, 10).replace(/-/g, "/")}`;
  }
  const outbound = await gmailList(token, outboundQ, UNANSWERED_CAP);

  // 3. Most recent outbound overall — separate one-result query when
  //    the streak is empty, since the `after:` filter would have
  //    excluded it.
  let lastOutboundAt: string | null = null;
  if (outbound.ids.length > 0) {
    const meta = await messageMeta(token, outbound.ids[0]);
    lastOutboundAt = meta.internalDate;
  } else {
    const anyOutbound = await gmailList(
      token,
      `in:sent ` + outboundUnion + NOISE_FILTERS,
      1
    );
    if (anyOutbound.ids.length > 0) {
      const meta = await messageMeta(token, anyOutbound.ids[0]);
      lastOutboundAt = meta.internalDate;
    }
  }

  const unanswered = outbound.ids.length;
  const daysSinceInbound = lastInboundAt
    ? Math.floor(
        (Date.now() - Date.parse(lastInboundAt)) / (24 * 60 * 60 * 1000)
      )
    : null;

  return {
    status: deriveStatus(Boolean(lastOutboundAt), unanswered),
    last_inbound_at: lastInboundAt,
    last_inbound_from: lastInboundFrom,
    last_outbound_at: lastOutboundAt,
    unanswered_outbound: unanswered,
    unanswered_capped: unanswered >= UNANSWERED_CAP,
    days_since_inbound: daysSinceInbound,
    fetched_at: new Date().toISOString(),
  };
}

// ─── Cache ───────────────────────────────────────────────────────────

function cacheKey(csmEmail: string, customerKey: string): string {
  return (
    CACHE_KEY_PREFIX +
    csmEmail.trim().toLowerCase() +
    ":" +
    customerKey.trim().toLowerCase()
  );
}

export async function responsivenessForCustomerCached(
  csmEmail: string,
  signals: CustomerSignals,
  opts?: { forceFresh?: boolean }
): Promise<ResponsivenessBatchEntry> {
  const key = cacheKey(csmEmail, signals.key);
  if (!opts?.forceFresh) {
    const cached = await kvGet<ResponsivenessResult>(key);
    const fetchedMs = cached?.fetched_at ? Date.parse(cached.fetched_at) : NaN;
    if (
      cached &&
      Number.isFinite(fetchedMs) &&
      Date.now() - fetchedMs <= CACHE_TTL_MS
    ) {
      return { ...cached, cached: true };
    }
  }
  const fresh = await responsivenessForCustomer(csmEmail, signals);
  await kvSet(key, fresh);
  return { ...fresh, cached: false };
}

/**
 * Batch wrapper. Sequential rather than parallel on purpose: each
 * customer costs 2–4 Gmail calls, so a 60-account book fanned out at
 * once is a fast route to a 429 that poisons the whole run. The
 * caller is a background refresh, not a page render.
 *
 * A scope error aborts the whole batch (the token is bad for every
 * row, so continuing just burns quota); any other per-row error is
 * recorded and the run continues.
 */
export async function responsivenessBatch(
  csmEmail: string,
  customers: CustomerSignals[],
  opts?: { forceFresh?: boolean }
): Promise<{
  results: Record<string, ResponsivenessBatchEntry>;
  errors: Array<{ key: string; error: string }>;
}> {
  const results: Record<string, ResponsivenessBatchEntry> = {};
  const errors: Array<{ key: string; error: string }> = [];
  for (const signals of customers) {
    try {
      results[signals.key] = await responsivenessForCustomerCached(
        csmEmail,
        signals,
        opts
      );
    } catch (e) {
      if (e instanceof GmailReadScopeError) throw e;
      errors.push({
        key: signals.key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { results, errors };
}
