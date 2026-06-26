import { kvGet, kvSet } from "../storage/kv";
import type { Customer, HubSpotContactRef } from "../types";

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
 * Overlay is intentionally narrow — only the fields the HubSpot
 * resync path can refresh end-to-end. Metabase-sourced fields
 * (ARR, MRR, subs, last_send) stay from the snapshot. Risk and
 * status (HubSpot properties that come through Metabase) ARE
 * editable in HubSpot but require a Metabase sync to refresh,
 * so they're NOT in the overlay.
 */

const KEY = "csm:hubspot-overlay:v1";

export interface HubSpotOverlayRow {
  hubspot_contacts: HubSpotContactRef[] | null;
  last_activity_at: string | null;
  last_activity_source: string | null;
  property_customer_folder: string | null;
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

/** Merge an overlay blob into an in-memory customer list. Pure —
 *  returns a new array with overlaid rows. Customers not in the
 *  overlay map are passed through unchanged. */
export function mergeOverlayInto(
  customers: Customer[],
  overlay: HubSpotOverlayBlob
): Customer[] {
  if (Object.keys(overlay.rows).length === 0) return customers;
  return customers.map((c) => {
    if (!c.workspace_id) return c;
    const row = overlay.rows[c.workspace_id];
    if (!row) return c;
    return {
      ...c,
      hubspot_contacts: row.hubspot_contacts ?? c.hubspot_contacts,
      last_activity_at: row.last_activity_at ?? c.last_activity_at,
      last_activity_source:
        row.last_activity_source ?? c.last_activity_source,
      property_customer_folder:
        row.property_customer_folder ?? c.property_customer_folder,
    };
  });
}
