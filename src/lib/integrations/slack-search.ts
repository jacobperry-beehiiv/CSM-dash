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
 * ─── Why the USER token ────────────────────────────────────────
 * `search.messages` requires a `search:read` scope, which Slack
 * ONLY grants to user tokens (`xoxp-…`), never bot tokens. The
 * upgrade-analysis scan runs as the logged-in CSM's session, but
 * we deliberately share a single dedicated user token (from
 * SLACK_USER_TOKEN) so the search matches the same corpus for
 * every CSM regardless of their own channel membership. Without
 * the env var set, the helper returns [] — the panel then
 * renders its "no prior D&C decisions found" empty state, same
 * as it would for a scan that ran and found nothing.
 *
 * Fail-open posture — same as the Spamhaus helper: any Slack API
 * error resolves to `[]` with a warn so a Slack outage doesn't
 * fail the scorecard. The escalation rule reads slack_signals as
 * a signal source, never as a requirement.
 */

import type { SlackSearchHit } from "../engines/upgrade-analysis/types";

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
 * token's corpus. Returns SlackSearchHit[] for the engine to fold
 * into the report; returns [] on any failure.
 */
export async function searchSlackMessages(
  query: string,
  opts?: { count?: number; matchedTerm?: string }
): Promise<SlackSearchHit[]> {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) return [];
  const q = query.trim();
  if (!q) return [];

  const params = new URLSearchParams({
    query: q,
    count: String(opts?.count ?? DEFAULT_COUNT),
    // Newest first — a decade of older mentions isn't what the
    // scorecard cares about; a recent "offboarded" note is.
    sort: "timestamp",
    sort_dir: "desc",
  });

  const doFetch = async (): Promise<SlackSearchMessagesResponse | null> => {
    const res = await fetch(SLACK_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      console.warn(
        `[slack-search] HTTP ${res.status} for query "${q}"`
      );
      return null;
    }
    const body = (await res.json()) as SlackSearchMessagesResponse;
    if (!body.ok) {
      // `not_authed` / `invalid_auth` here means the shipped
      // SLACK_USER_TOKEN is missing search:read or has been rotated.
      // Warn loudly so ops notices without failing the scan.
      console.warn(
        `[slack-search] Slack API error for query "${q}": ${body.error}`
      );
      return null;
    }
    return body;
  };

  const body = await withTimeout(
    doFetch(),
    SEARCH_TIMEOUT_MS,
    null,
    `search:"${q}"`
  );
  if (!body) return [];

  const matches = body.messages?.matches ?? [];
  const matchedTerm = opts?.matchedTerm ?? q;
  return matches
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
 * pub_name is passed in quoted so multi-word names match as a phrase
 * (`"Sample Publication"`), not as an OR of the individual words.
 * Empty inputs are skipped rather than issuing an empty search.
 */
export async function slackSearchForUpgradeAnalysis(args: {
  pubId: string;
  ownerEmail?: string | null;
  pubName?: string | null;
  topN?: number;
}): Promise<SlackSearchHit[]> {
  const { pubId, ownerEmail, pubName, topN = 30 } = args;
  const searches: Array<Promise<SlackSearchHit[]>> = [];

  if (pubId.trim())
    searches.push(searchSlackMessages(pubId.trim(), { matchedTerm: pubId.trim() }));
  if (ownerEmail?.trim())
    searches.push(
      searchSlackMessages(ownerEmail.trim(), { matchedTerm: ownerEmail.trim() })
    );
  if (pubName?.trim()) {
    // Phrase-match multi-word names so a pub called "Media Pulse"
    // doesn't fire on every message that says "media" OR "pulse".
    const trimmed = pubName.trim();
    const phrase = /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
    searches.push(
      searchSlackMessages(phrase, { matchedTerm: trimmed })
    );
  }

  if (searches.length === 0) return [];

  const results = await Promise.all(searches);
  const merged: SlackSearchHit[] = [];
  const seen = new Set<string>();
  for (const hits of results) {
    for (const h of hits) {
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
  return merged.slice(0, topN);
}
