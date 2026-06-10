import type { Customer } from "./types";

/**
 * "Last contacted" used to mean `customer.property_notes_last_contacted`
 * verbatim — but that HubSpot property is narrow ("manually marked as a
 * contact event") and almost never populated. Sync-time enrichment via
 * src/lib/integrations/hubspot.ts now stamps `last_activity_at` onto each
 * row from HubSpot's company-level activity rollup, which captures
 * emails / calls / meetings / notes across every contact at the company.
 *
 * Gmail-direct enrichment (Phase 1) layers in a third source: the
 * active CSM's own mailbox. Callers that have pre-fetched a Gmail
 * date for the row (via `/api/last-contact/gmail`) pass it in as
 * `opts.gmailDate` and the merge prefers the freshest of the three.
 * When `gmailDate` is undefined the function behaves exactly as before
 * so existing call sites keep working unchanged.
 *
 * Use this helper everywhere "last contacted" is displayed or compared,
 * so the table, detail panel, account page, Flag H, and the merge tag
 * all read from the same source-of-truth resolution.
 */

export interface LastContacted {
  /** ISO date string, or null when no source has anything. */
  date: string | null;
  /** Short human-readable source label — used as the cell tooltip. */
  source:
    | "hubspot activity rollup"
    | "hubspot notes_last_contacted"
    | "gmail"
    | "none";
  /** Raw underlying source name when available (debug). For HubSpot
   *  sources this is the underlying property name; for gmail this is
   *  the literal "gmail" string. */
  raw_source?: string | null;
}

export interface LastContactedOpts {
  /** ISO date string from the Gmail-direct lookup, when available.
   *  Merged into the same max() pass as the HubSpot sources — the
   *  freshest date wins. */
  gmailDate?: string | null;
}

export function lastContacted(
  c: Customer,
  opts?: LastContactedOpts
): LastContacted {
  const hubspotNotes = c.property_notes_last_contacted ?? null;
  const activity = c.last_activity_at ?? null;
  const gmail = opts?.gmailDate ?? null;

  const hubspotMs = parseMs(hubspotNotes);
  const activityMs = parseMs(activity);
  const gmailMs = parseMs(gmail);

  // Pick the source with the maximum timestamp. Ties broken in the
  // historical priority order (gmail beats hubspot activity beats
  // notes_last_contacted) — Gmail is the most ground-truth source
  // for "I, the active CSM, last touched this account" so it wins
  // when dates are equal.
  const candidates: Array<{
    ms: number;
    date: string;
    source: LastContacted["source"];
    raw: string | null;
  }> = [];
  if (gmailMs !== null && gmail) {
    candidates.push({ ms: gmailMs, date: gmail, source: "gmail", raw: "gmail" });
  }
  if (activityMs !== null && activity) {
    candidates.push({
      ms: activityMs,
      date: activity,
      source: "hubspot activity rollup",
      raw: c.last_activity_source ?? null,
    });
  }
  if (hubspotMs !== null && hubspotNotes) {
    candidates.push({
      ms: hubspotMs,
      date: hubspotNotes,
      source: "hubspot notes_last_contacted",
      raw: "notes_last_contacted",
    });
  }
  if (candidates.length === 0) {
    return { date: null, source: "none", raw_source: null };
  }
  candidates.sort((a, b) => b.ms - a.ms);
  const winner = candidates[0];
  return {
    date: winner.date,
    source: winner.source,
    raw_source: winner.raw,
  };
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Subscriber utilization as a fraction of plan cap.
 *   0.50 → 50% of cap
 *   1.00 → at cap
 *   1.75 → 175% of cap (over)
 *
 * Returns null when neither active_subs/max_subscriptions nor
 * percent_of_max_subs is usable.
 *
 * Why this exists: the q10600 `percent_of_max_subs` column has
 * historical ambiguity — sometimes the warehouse stores it as a
 * fraction (0.75), sometimes as a percentage (75). Callers used a
 * `> 1 ? /100 : x` heuristic to disambiguate, which broke for any
 * customer over 100% of cap: a legitimate 1.75 fraction would be
 * treated as a 175% percentage and divided by 100 to 0.0175,
 * displaying as "2%". The bug fired the under-cap at-risk flag on
 * customers who were actually *over* cap (most-egregious symptom:
 * a Yellow-flagged 438K-subs customer with 250K cap showing as
 * "2% of max subs").
 *
 * Fix: prefer the direct `active_subs / max_subscriptions` ratio
 * when both fields are present (the typical case). Only fall back
 * to percent_of_max_subs when one of those is null, and treat
 * values > 2 as percentages (heuristic only reliable when the
 * fraction can't be derived directly).
 */
export function subUtilFraction(c: {
  active_subs: number | null;
  max_subscriptions: number | null;
  percent_of_max_subs: number | null;
}): number | null {
  if (
    c.active_subs != null &&
    c.max_subscriptions != null &&
    c.max_subscriptions > 0
  ) {
    return c.active_subs / c.max_subscriptions;
  }
  if (c.percent_of_max_subs == null) return null;
  // No active_subs / max_subscriptions to cross-check against —
  // fall back to the legacy heuristic. > 2 strongly implies the
  // value is a percentage (200%+); 0–2 is ambiguous but assumed
  // fraction (the historical default).
  return c.percent_of_max_subs > 2
    ? c.percent_of_max_subs / 100
    : c.percent_of_max_subs;
}
