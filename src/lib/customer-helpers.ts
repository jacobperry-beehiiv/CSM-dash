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
