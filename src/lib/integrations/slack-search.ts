/**
 * Slack search helper — powers the D&C Upgrade Analysis Slack read.
 *
 * D&C's manual investigation opens Slack and searches by pub_id,
 * owner_email, and pub_name to check whether the account has been
 * discussed before (prior "do not upgrade" or "offboarded"
 * decisions, active abuse threads, etc.). This helper is the code
 * path that runs those same searches automatically and folds the
 * results into the scan report.
 *
 * ─── Which token ───────────────────────────────────────────────
 * Slack's `search.messages` endpoint requires a USER token
 * (`xoxp-…`) with the `search:read` scope. Bot tokens are rejected
 * with `not_allowed_token_type` (verified in prod), and the
 * `search:read.public` bot scope that appears in the app config
 * UI does not actually enable this endpoint. The helper reads
 * SLACK_USER_TOKEN as the primary env var. As a defensive
 * convenience it also reads SLACK_BOT_TOKEN, but only to detect
 * "user forgot to set the user token" — a bot token is treated as
 * `not_configured` because calling Slack would guaranteed-fail.
 *
 * Fail-open posture — same as the Spamhaus helper: any Slack API
 * error resolves to `[]` with a warn so a Slack outage doesn't
 * fail the scorecard. The escalation rule reads slack_signals as
 * a signal source, never as a requirement.
 */

import type { SlackSearchHit } from "../engines/upgrade-analysis/types";
import { getFreshSlackUserToken } from "./slack-user-token";

/** Terminal reason the Slack search returned no hits. `ok` = at least
 *  one query ran successfully (even if it matched nothing). The other
 *  values are diagnostic — they tell the UI what to say instead of
 *  the ambiguous "no matches" empty state. */
export type SlackSearchStatus =
  | "ok"
  | "not_configured" // neither SLACK_USER_TOKEN nor SLACK_BOT_TOKEN is set
  | "auth_error" // token present but scope wrong / rotated
  | "http_error" // Slack API returned 5xx or a non-auth failure
  | "timeout" // request exceeded SEARCH_TIMEOUT_MS
  | "no_query"; // nothing to search — no pub_id/email/name given

export interface SlackSearchResult {
  hits: SlackSearchHit[];
  status: SlackSearchStatus;
  /** Present on error statuses — the raw Slack error string
   *  (`not_authed`, `missing_scope`, etc.) or an HTTP status code
   *  for the panel to surface without a redeploy. */
  detail?: string;
}

const SLACK_SEARCH_URL = "https://slack.com/api/search.messages";

// Per-request timeout. Slack's search API is fast (<1s p95) but we
// still bound it so a rare hang can't stretch the parent scan's
// 60s ceiling. Three parallel searches with a 5s cap each keeps the
// scan's wall clock well within budget.
const SEARCH_TIMEOUT_MS = 5_000;

// Default page size. 20 is enough to spot prior decisions without
// dredging up years of unrelated mentions.
const DEFAULT_COUNT = 20;

interface SlackSearchMessagesResponse {
  ok?: boolean;
  error?: string;
  messages?: {
    matches?: Array<{
      channel?: { id?: string; name?: string };
      ts?: string;
      permalink?: string;
      text?: string;
    }>;
  };
}

/** Wrap a fetch with a hard timeout that resolves to a fallback
 *  rather than rejecting — mirrors the pillar-runner pattern in
 *  upgrade-analysis/pillars.ts so an integration outage never fails
 *  the parent scan. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[slack-search] ${label} timed out after ${ms}ms`);
      resolve(fallback);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        console.warn(
          `[slack-search] ${label} errored:`,
          err instanceof Error ? err.message : err
        );
        resolve(fallback);
      }
    );
  });
}

/**
 * Search Slack messages for a query string against the shared user
 * token's corpus. Returns a status-tagged result so the caller can
 * distinguish "search ran and matched nothing" from "not configured",
 * "auth failed", "HTTP error", or "timeout". Fail-open on hits: even
 * an error result carries an empty array so callers can treat `.hits`
 * uniformly.
 */
export async function searchSlackMessages(
  query: string,
  opts?: { count?: number; matchedTerm?: string }
): Promise<SlackSearchResult> {
  // Resolve a fresh user token via the persisted OAuth pair.
  // Rotation means we can't just read process.env — Slack expires
  // access tokens every ~12h and only ever emits the refresh_token
  // through the OAuth callback (never in a static config UI). The
  // helper handles refresh + single-flight; we just distinguish
  // "not connected" from "refresh broke" for the UI banner.
  const tokenOutcome = await getFreshSlackUserToken();
  if (tokenOutcome.kind === "not_configured") {
    return {
      hits: [],
      status: "not_configured",
      detail: tokenOutcome.detail,
    };
  }
  if (tokenOutcome.kind === "refresh_failed") {
    return {
      hits: [],
      status: "auth_error",
      detail: tokenOutcome.detail,
    };
  }
  const token = tokenOutcome.token;
  const q = query.trim();
  if (!q) return { hits: [], status: "no_query" };

  const params = new URLSearchParams({
    query: q,
    count: String(opts?.count ?? DEFAULT_COUNT),
    // Newest first — a decade of older mentions isn't what the
    // scorecard cares about; a recent "offboarded" note is.
    sort: "timestamp",
    sort_dir: "desc",
  });

  // Inner fetch returns a tagged verdict so timeouts / auth errors
  // can be surfaced separately from an empty-match success.
  type FetchOutcome =
    | { kind: "ok"; body: SlackSearchMessagesResponse }
    | { kind: "http_error"; detail: string }
    | { kind: "auth_error"; detail: string };
  const doFetch = async (): Promise<FetchOutcome> => {
    const res = await fetch(SLACK_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = `HTTP ${res.status}`;
      console.warn(`[slack-search] ${detail} for query "${q}"`);
      return { kind: "http_error", detail };
    }
    const body = (await res.json()) as SlackSearchMessagesResponse;
    if (!body.ok) {
      const detail = body.error ?? "unknown_error";
      console.warn(
        `[slack-search] Slack API error for query "${q}": ${detail}`
      );
      // `not_authed` / `invalid_auth` / `missing_scope` all point at
      // the SLACK_USER_TOKEN — either absent, wrong scope, or rotated.
      const isAuth =
        detail === "not_authed" ||
        detail === "invalid_auth" ||
        detail === "missing_scope" ||
        detail === "token_revoked";
      return {
        kind: isAuth ? "auth_error" : "http_error",
        detail,
      };
    }
    return { kind: "ok", body };
  };

  const outcome = await withTimeout(
    doFetch(),
    SEARCH_TIMEOUT_MS,
    { kind: "http_error" as const, detail: "timeout" },
    `search:"${q}"`
  );
  if (outcome.kind === "auth_error") {
    return { hits: [], status: "auth_error", detail: outcome.detail };
  }
  if (outcome.kind === "http_error") {
    return {
      hits: [],
      status: outcome.detail === "timeout" ? "timeout" : "http_error",
      detail: outcome.detail,
    };
  }

  const matches = outcome.body.messages?.matches ?? [];
  const matchedTerm = opts?.matchedTerm ?? q;
  const hits: SlackSearchHit[] = matches
    .filter((m) => m.channel?.id && m.ts && m.permalink)
    .map((m) => ({
      channel_id: String(m.channel?.id ?? ""),
      channel_name: m.channel?.name ? String(m.channel.name) : undefined,
      ts: String(m.ts ?? ""),
      permalink: String(m.permalink ?? ""),
      // Cap the snippet — the scorecard renders this inline and a
      // wall-of-text match hides the useful preview under one entry.
      snippet: truncate(String(m.text ?? ""), 320),
      matched_term: matchedTerm,
    }));
  return { hits, status: "ok" };
}

/** Stopword list — single-word pub names that produce garbage under
 *  phrase search. These match every Slack chatter about "the weekly
 *  news", "our daily digest", etc. When one of these is the entire
 *  pub name, we skip the pub_name query and lean on pub_id + email.
 *  Kept intentionally small — extend as we see false positives in
 *  the panel. */
const PUB_NAME_STOPWORDS = new Set([
  "news",
  "newsletter",
  "daily",
  "weekly",
  "monthly",
  "digest",
  "brief",
  "briefing",
  "update",
  "updates",
  "post",
  "posts",
  "the",
  "media",
  "insider",
  "report",
]);

/** True when the pub name is worth phrase-searching. Skips short
 *  single-word names (a 2-3 char name is basically guaranteed to
 *  false-positive) and the stopword list. Multi-word names always
 *  qualify — even something like "The Weekly" is distinctive enough
 *  as a phrase to be worth the call. */
function isDistinctivePubName(name: string): boolean {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 1) return true;
  const single = words[0]?.toLowerCase() ?? "";
  if (single.length <= 3) return false;
  if (PUB_NAME_STOPWORDS.has(single)) return false;
  return true;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/**
 * Run D&C's three-part Slack read in parallel — pub_id, owner_email,
 * and pub_name — dedupe by (channel_id, ts), and return the newest
 * `topN` matches. Each search is independently fail-open; a single
 * failure doesn't lose the results from the others.
 *
 * Every term is quoted before sending. Slack's search tokenizer
 * breaks on `-`, `@`, `.` and other separators — an unquoted UUID
 * matches on its dash-separated parts, an unquoted email matches on
 * the local part OR the domain OR either side of a dot, and an
 * unquoted single-word pub name matches every mention. Quoting
 * forces exact-phrase match and cuts noise dramatically.
 *
 * pub_name has an extra guard: skip the search when the name is a
 * short single word (≤ 3 chars) or matches a stopword. A pub
 * called "News", "Daily", or "The" produces thousands of unrelated
 * hits and washes out the signal from pub_id + email. pub_id is
 * always run since UUIDs don't have this problem.
 */
export async function slackSearchForUpgradeAnalysis(args: {
  pubId: string;
  ownerEmail?: string | null;
  pubName?: string | null;
  topN?: number;
}): Promise<SlackSearchResult> {
  const { pubId, ownerEmail, pubName, topN = 30 } = args;
  const searches: Array<Promise<SlackSearchResult>> = [];

  if (pubId.trim()) {
    const trimmed = pubId.trim();
    searches.push(
      searchSlackMessages(`"${trimmed}"`, { matchedTerm: trimmed })
    );
  }
  if (ownerEmail?.trim()) {
    const trimmed = ownerEmail.trim();
    searches.push(
      searchSlackMessages(`"${trimmed}"`, { matchedTerm: trimmed })
    );
  }
  if (pubName?.trim()) {
    const trimmed = pubName.trim();
    if (isDistinctivePubName(trimmed)) {
      searches.push(
        searchSlackMessages(`"${trimmed}"`, { matchedTerm: trimmed })
      );
    }
  }

  if (searches.length === 0) {
    return { hits: [], status: "no_query" };
  }

  const results = await Promise.all(searches);
  const merged: SlackSearchHit[] = [];
  const seen = new Set<string>();
  // Roll up statuses — an auth_error on any query is the diagnostic
  // the user cares about, so it dominates. Otherwise: not_configured
  // dominates over transient errors, over ok. `ok` wins only when at
  // least one query completed successfully (even if it matched
  // nothing).
  const priority: SlackSearchStatus[] = [
    "auth_error",
    "not_configured",
    "http_error",
    "timeout",
    "no_query",
    "ok",
  ];
  let worst: SlackSearchStatus = "ok";
  let detail: string | undefined;
  for (const result of results) {
    if (priority.indexOf(result.status) < priority.indexOf(worst)) {
      worst = result.status;
      detail = result.detail;
    }
    for (const h of result.hits) {
      const key = `${h.channel_id}:${h.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
    }
  }

  // Slack's `ts` is a UNIX epoch with microseconds; lexicographic
  // sort is safe (all values are same-length after the decimal
  // in practice, and larger = more recent).
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { hits: merged.slice(0, topN), status: worst, detail };
}
