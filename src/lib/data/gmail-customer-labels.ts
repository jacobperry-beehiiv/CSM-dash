import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-CSM mapping of dashboard customer (workspace_id) → existing
 * Gmail label. The dashboard does NOT create labels in Gmail — it
 * reads the labels each CSM already maintains by hand and routes
 * dashboard-generated drafts under the right one.
 *
 * Storage:
 *   • Single KV row keyed `csm:gmail-customer-labels:v1`.
 *   • Top-level keyed by csm email (lowercased). Each CSM has their
 *     own Gmail, their own labels, so the mapping is fully per-user
 *     even though we pack everyone into one row to keep reads to a
 *     single round-trip.
 *
 * `source` distinguishes:
 *   • "inferred" — the bulk scan picked this label from thread
 *     history. Auto-overwritten by future scans.
 *   • "manual"   — a CSM picked this label from the dropdown on
 *     /settings/gmail-labels. Sticky — future scans skip the row.
 *   • "cleared"  — a CSM explicitly opted this customer out of
 *     auto-labeling. Sticky in the same way.
 */

const KEY = "csm:gmail-customer-labels:v1";

export type LabelMappingSource = "inferred" | "manual" | "cleared";

export interface CustomerLabelRow {
  /** Gmail labelId (e.g. "Label_4823"). Null when source === "cleared"
   *  so callers don't accidentally apply a stale id. */
  label_id: string | null;
  /** Human-readable label name as of the last write. Used to
   *  re-resolve `label_id` when Gmail returns a stale-id error
   *  (label deleted + recreated under a new id). */
  label_name: string | null;
  source: LabelMappingSource;
  /** When the inferring scan ran (only set for source === "inferred"). */
  inferred_at?: string;
  /** When a CSM manually set / cleared (only set for "manual" /
   *  "cleared"). */
  updated_at?: string;
}

export interface CsmLabelBook {
  /** Keyed by workspace_id. */
  rows: Record<string, CustomerLabelRow>;
  /** Last time the bulk-scan endpoint ran for this CSM. Surfaced in
   *  the settings UI so a CSM knows whether the mapping is stale. */
  last_full_scan?: string;
}

export interface CustomerLabelMap {
  /** Keyed by csm email, lowercased. */
  per_csm: Record<string, CsmLabelBook>;
  fetched_at: string;
}

const EMPTY_MAP: CustomerLabelMap = {
  per_csm: {},
  fetched_at: new Date(0).toISOString(),
};

export async function loadCustomerLabels(): Promise<CustomerLabelMap> {
  const blob = await kvGet<CustomerLabelMap>(KEY);
  return blob ?? { ...EMPTY_MAP };
}

export async function saveCustomerLabels(
  blob: CustomerLabelMap
): Promise<void> {
  await kvSet<CustomerLabelMap>(KEY, {
    ...blob,
    fetched_at: new Date().toISOString(),
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Read the label book for one CSM. Returns an empty book if the
 *  CSM has no entries yet. Pure read — no mutation. */
export function getCsmLabelBook(
  blob: CustomerLabelMap,
  csmEmail: string
): CsmLabelBook {
  const key = normalizeEmail(csmEmail);
  return blob.per_csm[key] ?? { rows: {} };
}

/**
 * Set / overwrite one (csm, workspace_id) → label row. Atomic on
 * the in-memory blob — call `saveCustomerLabels()` after to persist.
 *
 * Source semantics:
 *   • "inferred": only writes if the existing row is "inferred" or
 *     absent. Refuses to overwrite "manual" / "cleared" so a CSM's
 *     hand-picked override isn't blown away by the next scan.
 *   • "manual" / "cleared": always overwrites. CSM intent wins.
 *
 * Returns the blob (mutated in place) for fluent chaining.
 */
export function setCustomerLabel(
  blob: CustomerLabelMap,
  csmEmail: string,
  workspaceId: string,
  row: CustomerLabelRow
): CustomerLabelMap {
  const key = normalizeEmail(csmEmail);
  const book = blob.per_csm[key] ?? { rows: {} };
  const existing = book.rows[workspaceId];
  if (
    row.source === "inferred" &&
    existing &&
    (existing.source === "manual" || existing.source === "cleared")
  ) {
    // Pinned overrides are sacrosanct — scan can't touch them.
    return blob;
  }
  book.rows[workspaceId] = row;
  blob.per_csm[key] = book;
  return blob;
}

/** Stamp the last_full_scan timestamp on a CSM's book. Mutates in
 *  place; pair with `saveCustomerLabels()`. */
export function stampScanCompletion(
  blob: CustomerLabelMap,
  csmEmail: string,
  at: string = new Date().toISOString()
): CustomerLabelMap {
  const key = normalizeEmail(csmEmail);
  const book = blob.per_csm[key] ?? { rows: {} };
  book.last_full_scan = at;
  blob.per_csm[key] = book;
  return blob;
}

/** Convenience: workspaceId → labelId lookup for one CSM. Skips
 *  cleared rows (returns no entry) and rows whose label_id is null. */
export function buildLabelLookup(
  blob: CustomerLabelMap,
  csmEmail: string
): Map<string, { label_id: string; label_name: string | null }> {
  const lookup = new Map<string, { label_id: string; label_name: string | null }>();
  const book = getCsmLabelBook(blob, csmEmail);
  for (const [workspaceId, row] of Object.entries(book.rows)) {
    if (row.source === "cleared") continue;
    if (!row.label_id) continue;
    lookup.set(workspaceId, {
      label_id: row.label_id,
      label_name: row.label_name,
    });
  }
  return lookup;
}
