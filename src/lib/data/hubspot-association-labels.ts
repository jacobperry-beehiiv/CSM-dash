import { kvGet, kvSet } from "../storage/kv";

/**
 * KV-cached map of company-contact association labels exposed by
 * the team's HubSpot portal. The set is small (a dozen entries
 * tops) and rarely changes, so a 24h refresh-on-stale window keeps
 * the dashboard responsive without hammering HubSpot.
 *
 * Why we need this: HubSpot's v4 association-write endpoint takes
 * numeric `associationTypeId`s, not the human-readable label
 * strings. The dashboard speaks labels ("Main Contact",
 * "Decision Maker"), so we keep the mapping here and resolve at
 * write time. Reads are also cached so the detail-panel picker
 * can show every available label even on customers that haven't
 * used a given label yet.
 *
 * Refresh paths:
 *   • lazy: any read past 24h refreshes inline.
 *   • admin: `/admin/flags` button → `refreshAssociationLabels()`
 *     for "I just added a new label in HubSpot — surface it now."
 */

const KEY = "csm:hubspot:association-labels:v1";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface AssociationLabel {
  /** Numeric id HubSpot's write endpoint expects. */
  typeId: number;
  /** Human-readable label as configured in HubSpot. */
  label: string;
  /** `USER_DEFINED` for admin-created labels (the ones CSMs care
   *  about); `HUBSPOT_DEFINED` includes the canned primary-association
   *  typeId and the default unlabeled association. */
  category: "USER_DEFINED" | "HUBSPOT_DEFINED";
}

export interface AssociationLabelsEntry {
  labels: AssociationLabel[];
  fetched_at: string;
}

/** Lazy read. Returns the cached set; refreshes from HubSpot
 *  silently when older than TTL_MS or missing. */
export async function loadAssociationLabels(): Promise<AssociationLabel[]> {
  const cached = await kvGet<AssociationLabelsEntry>(KEY);
  if (cached) {
    const age = Date.now() - Date.parse(cached.fetched_at);
    if (Number.isFinite(age) && age < TTL_MS) return cached.labels;
  }
  return refreshAssociationLabels();
}

/** Force-refresh from HubSpot. Admin-triggered button calls this
 *  too. Throws on HubSpot error; the caller surfaces a UI error. */
export async function refreshAssociationLabels(): Promise<AssociationLabel[]> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "HUBSPOT_ACCESS_TOKEN is not set — cannot fetch association labels."
    );
  }
  const res = await fetch(
    "https://api.hubapi.com/crm/v4/associations/companies/contacts/labels",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HubSpot association-labels fetch failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as {
    results?: Array<{
      typeId?: number;
      label?: string | null;
      category?: string | null;
    }>;
  };
  const labels: AssociationLabel[] = [];
  for (const r of json.results ?? []) {
    if (typeof r.typeId !== "number") continue;
    if (typeof r.label !== "string") continue;
    const trimmed = r.label.trim();
    if (!trimmed) continue;
    const category =
      r.category === "USER_DEFINED" ? "USER_DEFINED" : "HUBSPOT_DEFINED";
    labels.push({ typeId: r.typeId, label: trimmed, category });
  }
  // Sort: USER_DEFINED first (the ones the team actually uses),
  // then alphabetical within each category.
  labels.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category === "USER_DEFINED" ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
  await kvSet<AssociationLabelsEntry>(KEY, {
    labels,
    fetched_at: new Date().toISOString(),
  });
  return labels;
}

/** Resolve a list of human label strings to typeIds via the cache.
 *  Returns `{ resolved, unknown }` — caller decides whether unknown
 *  labels are a soft warning or a hard 400. */
export async function resolveLabelTypeIds(
  labels: string[]
): Promise<{ resolved: number[]; unknown: string[] }> {
  const all = await loadAssociationLabels();
  const lookup = new Map<string, number>();
  for (const a of all) {
    lookup.set(a.label.toLowerCase(), a.typeId);
  }
  const resolved: number[] = [];
  const unknown: string[] = [];
  const seen = new Set<number>();
  for (const raw of labels) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const id = lookup.get(k);
    if (id === undefined) {
      unknown.push(raw);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    resolved.push(id);
  }
  return { resolved, unknown };
}
