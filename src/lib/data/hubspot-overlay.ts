import { kvGet, kvSet } from "../storage/kv";
import type { Customer, HubSpotContactRef } from "../types";
import type { OverrideMap } from "./customer-overrides";

/**
 * Live HubSpot-overlay for the customer book.
 *
 * The daily sync writes the encrypted snapshot, which the dashboard
 * reads on every server-render. That's the source of truth for "what
 * Metabase + HubSpot looked like as of 06:00 UTC." When a CSM edits
 * a label, owner, or Customer-Folder URL in HubSpot and wants to
 * see the change without waiting for the next cron, the "Resync
 * from HubSpot" button writes a fresh overlay into this KV row;
 * `loadCustomers()` merges the overlay on top of the snapshot on
 * the next page render.
 *
 * Storage shape:
 *   • Single KV row keyed `csm:hubspot-overlay:v1`.
 *   • Value: `{ rows: Record<workspace_id, OverlayRow>, fetched_at }`.
 *
 * Why one row not N: bulk read on every page-render is one round
 * trip regardless of book size. With ~150 customers × all the
 * Customer fields we override, the serialized JSON stays small
 * enough (< 200 KB) that we don't need per-workspace splitting.
 *
 * Overlay covers the fields the HubSpot batch API can serve
 * directly — no Metabase round-trip needed. Metabase-sourced
 * fields (ARR, MRR, subs, last_send) stay from the snapshot.
 * Company-level HubSpot properties that CSMs edit mid-day
 * (touch level, risk level, customer-folder URL, last-activity
 * rollup) all pull straight from HubSpot on demand so the resync
 * button reflects the change without waiting for the twice-daily
 * Metabase snapshot rebuild.
 */

const KEY = "csm:hubspot-overlay:v1";

export interface HubSpotOverlayRow {
  hubspot_contacts: HubSpotContactRef[] | null;
  last_activity_at: string | null;
  last_activity_source: string | null;
  property_customer_folder: string | null;
  /** Touch level — HubSpot's `company_engagement` enum (No / Low /
   *  Medium / High / Very High Touch, plus Downgrade + Churned).
   *  Populated by the resync route; null means "resync hasn't run
   *  yet for this workspace" (fall back to snapshot value). */
  company_engagement: string | null;
  /** Risk level — HubSpot's `risk_level__csm_` enum (Green / Light
   *  Green / Yellow / Red). Same posture as company_engagement. */
  property_risk_level: string | null;
  fetched_at: string;
}

export interface HubSpotOverlayBlob {
  rows: Record<string, HubSpotOverlayRow>;
  fetched_at: string;
}

export async function loadHubspotOverlay(): Promise<HubSpotOverlayBlob> {
  const blob = await kvGet<HubSpotOverlayBlob>(KEY);
  if (!blob) return { rows: {}, fetched_at: new Date(0).toISOString() };
  return blob;
}

export async function saveHubspotOverlay(
  blob: HubSpotOverlayBlob
): Promise<void> {
  await kvSet<HubSpotOverlayBlob>(KEY, blob);
}

/** Drop overlay rows for workspace_ids absent from `keep`. Used by
 *  the refresh endpoint so customers removed from the active scope
 *  don't leave stale rows lingering across sweeps. */
export async function pruneHubspotOverlay(keep: Set<string>): Promise<number> {
  const blob = await loadHubspotOverlay();
  let removed = 0;
  for (const id of Object.keys(blob.rows)) {
    if (!keep.has(id)) {
      delete blob.rows[id];
      removed++;
    }
  }
  if (removed > 0) {
    blob.fetched_at = new Date().toISOString();
    await saveHubspotOverlay(blob);
  }
  return removed;
}

/**
 * Fields this overlay writes that a CSM can ALSO edit from the
 * dashboard, via the mapped-field editor.
 *
 * These are the contended ones. Everything else the overlay carries
 * (contacts, last activity) has no edit path, so the overlay is
 * unambiguously the better value and just wins.
 */
const EDITABLE_OVERLAY_FIELDS = [
  "property_risk_level",
  "company_engagement",
  "property_customer_folder",
] as const;

/**
 * Merge an overlay blob into an in-memory customer list. Pure —
 * returns a new array with overlaid rows. Customers not in the
 * overlay map are passed through unchanged.
 *
 * `overrides` decides who wins on a contended field.
 *
 * This used to take no overrides and overwrite unconditionally, which
 * silently discarded CSM edits. `loadCustomers` applies overrides and
 * THEN merges this overlay on top, so for any workspace that had ever
 * been resynced, editing Risk level wrote the override, pushed to
 * HubSpot, and then rendered the overlay's months-old value anyway —
 * the edit looked like it hadn't saved.
 *
 * Resolution is by timestamp rather than a blanket "override wins",
 * because both directions are legitimate:
 *
 *   • Edit in the dashboard  → override.updated_at is newest, and the
 *     dashboard also pushes to HubSpot, so the two agree.
 *   • Edit in HubSpot, then Resync → row.fetched_at is newest and
 *     carries the external change, which should win.
 *
 * `fetched_at` is when we READ HubSpot, so it's an upper bound on how
 * current that value is — good enough to order against an edit we
 * timestamped ourselves.
 */
export function mergeOverlayInto(
  customers: Customer[],
  overlay: HubSpotOverlayBlob,
  overrides: OverrideMap = {}
): Customer[] {
  if (Object.keys(overlay.rows).length === 0) return customers;
  return customers.map((c) => {
    if (!c.workspace_id) return c;
    const row = overlay.rows[c.workspace_id];
    if (!row) return c;

    // A contended field takes the overlay's value only when the
    // overlay is at least as fresh as the CSM's edit. `c` already has
    // the override applied, so "keep c's value" is how the override
    // wins.
    const bag = overrides[c.workspace_id]?.field_overrides ?? {};
    const overlayWins = (field: (typeof EDITABLE_OVERLAY_FIELDS)[number]) => {
      const edited = bag[field]?.updated_at;
      if (!edited) return true;
      return row.fetched_at >= edited;
    };

    return {
      ...c,
      hubspot_contacts: row.hubspot_contacts ?? c.hubspot_contacts,
      last_activity_at: row.last_activity_at ?? c.last_activity_at,
      last_activity_source:
        row.last_activity_source ?? c.last_activity_source,
      property_customer_folder: overlayWins("property_customer_folder")
        ? (row.property_customer_folder ?? c.property_customer_folder)
        : c.property_customer_folder,
      company_engagement: overlayWins("company_engagement")
        ? (row.company_engagement ?? c.company_engagement)
        : c.company_engagement,
      property_risk_level: overlayWins("property_risk_level")
        ? (row.property_risk_level ?? c.property_risk_level)
        : c.property_risk_level,
    };
  });
}
