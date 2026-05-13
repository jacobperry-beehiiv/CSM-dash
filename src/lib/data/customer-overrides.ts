import type { Customer } from "../types";
import { kvGet, kvSet } from "../storage/kv";

/**
 * CSM-set per-customer overrides that don't round-trip through HubSpot/
 * Stripe but should still affect the dashboard view. Currently used to
 * toggle billing cadence (monthly ↔ annual) so a CSM can preview tier
 * pricing in the other cadence without waiting on Finance to switch the
 * Stripe subscription.
 */

export interface CustomerOverride {
  /** Override the customer's `interval` (e.g. "annual" or "month"). */
  interval?: "annual" | "month";
}

export type OverrideMap = Record<string, CustomerOverride>;

const KEY = "customer-overrides";

/**
 * No module-level cache here. The previous "load once, keep forever"
 * pattern caused stale reads on Vercel's warm-pool model: when one
 * isolate handled the POST and updated its in-memory cache, other warm
 * isolates kept returning the pre-write map forever — so cadence
 * toggles appeared to "revert" on refresh. The map is small and KV
 * reads against Postgres are sub-ms, so just always read fresh.
 */
export async function loadOverrides(): Promise<OverrideMap> {
  return (await kvGet<OverrideMap>(KEY)) ?? {};
}

export async function setOverride(
  workspaceId: string,
  patch: CustomerOverride
): Promise<OverrideMap> {
  const map = { ...(await loadOverrides()) };
  const current = { ...(map[workspaceId] ?? {}) };
  // Empty patch (or `interval` set to undefined) clears the field.
  if (patch.interval === undefined) {
    delete current.interval;
  } else {
    current.interval = patch.interval;
  }
  if (Object.keys(current).length === 0) {
    delete map[workspaceId];
  } else {
    map[workspaceId] = current;
  }
  await kvSet(KEY, map);
  return map;
}

/** Apply overrides to a customer record. Returns a new object — does not mutate. */
export function applyOverride(
  customer: Customer,
  overrides: OverrideMap
): Customer {
  if (!customer.workspace_id) return customer;
  const ov = overrides[customer.workspace_id];
  if (!ov) return customer;
  return {
    ...customer,
    interval: ov.interval ?? customer.interval,
  };
}
