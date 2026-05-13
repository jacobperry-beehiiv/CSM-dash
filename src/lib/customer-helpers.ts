import type { Customer } from "./types";

/**
 * "Last contacted" used to mean `customer.property_notes_last_contacted`
 * verbatim — but that HubSpot property is narrow ("manually marked as a
 * contact event") and almost never populated. Sync-time enrichment via
 * src/lib/integrations/hubspot.ts now stamps `last_activity_at` onto each
 * row from HubSpot's company-level activity rollup, which captures
 * emails / calls / meetings / notes across every contact at the company.
 *
 * Use this helper everywhere "last contacted" is displayed or compared,
 * so the table, detail panel, account page, Flag H, and the merge tag
 * all read from the same source-of-truth resolution.
 */

export interface LastContacted {
  /** ISO date string, or null when neither source has anything. */
  date: string | null;
  /** Short human-readable source label — used as the cell tooltip. */
  source:
    | "hubspot activity rollup"
    | "hubspot notes_last_contacted"
    | "none";
  /** Raw underlying HubSpot property name when available (debug). */
  raw_source?: string | null;
}

export function lastContacted(c: Customer): LastContacted {
  const hubspotNotes = c.property_notes_last_contacted ?? null;
  const activity = c.last_activity_at ?? null;

  const hubspotMs = parseMs(hubspotNotes);
  const activityMs = parseMs(activity);

  if (activityMs !== null && (hubspotMs === null || activityMs >= hubspotMs)) {
    return {
      date: activity,
      source: "hubspot activity rollup",
      raw_source: c.last_activity_source ?? null,
    };
  }
  if (hubspotMs !== null) {
    return {
      date: hubspotNotes,
      source: "hubspot notes_last_contacted",
      raw_source: "notes_last_contacted",
    };
  }
  return { date: null, source: "none", raw_source: null };
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}
