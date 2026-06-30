import { kvGet, kvSet } from "../storage/kv";

/**
 * KV-cached enum options for HubSpot company/contact properties.
 *
 * The dashboard renders dropdowns whose valid values are managed in
 * HubSpot (e.g. Customer Goals). We want the picker to match
 * HubSpot exactly so a CSM can't pick a value HubSpot will reject
 * on push — and we don't want to hand-mirror the option list in
 * source where it'll drift the moment someone edits the HubSpot
 * property.
 *
 * 24h refresh-on-stale window; admin can force-refresh via the
 * GET endpoint with ?refresh=1.
 *
 * Same shape + lifecycle as `hubspot-association-labels.ts`.
 */

const KEY_PREFIX = "csm:hubspot:property-options:v1:";
const TTL_MS = 24 * 60 * 60 * 1000;

export type HubspotObjectType = "companies" | "contacts";

export interface HubspotPropertyOption {
  label: string;
  value: string;
  displayOrder: number;
}

interface CacheEntry {
  options: HubspotPropertyOption[];
  fetched_at: string;
}

function cacheKey(
  objectType: HubspotObjectType,
  propertyName: string
): string {
  return `${KEY_PREFIX}${objectType}:${propertyName}`;
}

/** Lazy read. Returns the cached options; refreshes from HubSpot
 *  silently when older than TTL_MS or missing. Throws on HubSpot
 *  errors so the caller can surface them. */
export async function loadPropertyOptions(
  objectType: HubspotObjectType,
  propertyName: string
): Promise<HubspotPropertyOption[]> {
  const cached = await kvGet<CacheEntry>(cacheKey(objectType, propertyName));
  if (cached) {
    const age = Date.now() - Date.parse(cached.fetched_at);
    if (Number.isFinite(age) && age < TTL_MS) return cached.options;
  }
  return refreshPropertyOptions(objectType, propertyName);
}

/** Force-refresh from HubSpot's properties API. Throws on error;
 *  the caller (admin endpoint, settings page) surfaces it. */
export async function refreshPropertyOptions(
  objectType: HubspotObjectType,
  propertyName: string
): Promise<HubspotPropertyOption[]> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "HUBSPOT_ACCESS_TOKEN is not set — cannot fetch property options."
    );
  }
  const url =
    `https://api.hubapi.com/crm/v3/properties/${encodeURIComponent(objectType)}/` +
    encodeURIComponent(propertyName);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HubSpot property-options fetch failed for ${objectType}.${propertyName} (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as {
    options?: Array<{
      label?: string;
      value?: string;
      displayOrder?: number;
      hidden?: boolean;
    }>;
  };
  const options: HubspotPropertyOption[] = [];
  for (const o of json.options ?? []) {
    // Skip values HubSpot marks hidden — typically deprecated
    // legacy enum entries the team has chosen not to surface.
    if (o.hidden) continue;
    const value = typeof o.value === "string" ? o.value.trim() : "";
    if (!value) continue;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : value;
    options.push({
      label,
      value,
      displayOrder:
        typeof o.displayOrder === "number" ? o.displayOrder : Number.MAX_SAFE_INTEGER,
    });
  }
  // Stable order: HubSpot's `displayOrder` first (matches what
  // admins see in the HubSpot property editor), label alphabetical
  // as a tiebreaker.
  options.sort((a, b) => {
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
    return a.label.localeCompare(b.label);
  });
  await kvSet<CacheEntry>(cacheKey(objectType, propertyName), {
    options,
    fetched_at: new Date().toISOString(),
  });
  return options;
}
