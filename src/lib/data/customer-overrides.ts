import type { Customer } from "../types";
import { kvGet, kvSet } from "../storage/kv";

/**
 * CSM-set per-customer overrides that don't round-trip through HubSpot/
 * Stripe but should still affect the dashboard view. Currently used to:
 *
 *  - toggle billing cadence (monthly ↔ annual) so a CSM can preview
 *    tier pricing in the other cadence without waiting on Finance to
 *    switch the Stripe subscription
 *  - patch in a freshly-pulled CSM assignment from HubSpot when the
 *    Metabase snapshot is stale (see `refresh-csm` API route)
 */

export interface CustomerOverride {
  /** Override the customer's `interval` (e.g. "annual" or "month"). */
  interval?: "annual" | "month";
  /** Override the snake-cased CSM identifier (e.g. "olivia_chen"). When
   *  set, this trumps the value from Metabase q10600. */
  customer_success_manager?: string;
  /** Override the CSM's email — kept in lockstep with
   *  customer_success_manager so the cc-CSM flow stays consistent. */
  customer_success_manager_email?: string;
  /** ISO timestamp of the most-recent HubSpot pull. Renders as a tooltip
   *  on the "live" pill the detail panel surfaces next to the CSM. */
  csm_refreshed_at?: string;
  /** Viewer email that triggered the refresh — audit trail. */
  csm_refreshed_by?: string;
  /** User-facing lifecycle stage — drives the Lifecycle column dropdown
   *  on /am Renewals. Configurable list lives in
   *  settings.am.lifecycle_stages so admins can rename / add / remove
   *  values without code changes. Empty / undefined = no stage set. */
  lifecycle_stage?: string;
  lifecycle_stage_updated_at?: string;
  lifecycle_stage_updated_by?: string;
  /** Generic per-mapped-field overrides — keyed by the dashboard
   *  field id from MAPPABLE_DASHBOARD_FIELDS (e.g.,
   *  "property_risk_level"). Written by the "Edit" affordances on
   *  the customer detail panel when a field has push/both direction
   *  configured in /settings/hubspot-fields.
   *
   *  Using a generic bag instead of per-field columns means future
   *  mappable fields don't need a CustomerOverride schema change —
   *  only an entry in MAPPABLE_DASHBOARD_FIELDS and the UI to render
   *  the editor.
   *
   *  applyOverride() reads from this bag for any Customer field that
   *  has a matching entry, so the rest of the dashboard sees the
   *  override transparently. */
  field_overrides?: Record<
    string,
    {
      value: string | null;
      updated_at: string;
      updated_by?: string | null;
    }
  >;
  /** Override for `hubspot_company_id` — set by the manual
   *  "Re-resolve via Stripe ID" affordance when the sync snapshot
   *  has the wrong value (or none). Trumps the snapshot column when
   *  the dashboard renders, just like the CSM overrides do.
   *
   *  Paired with `hubspot_link_source` so the UI reflects the
   *  manual re-resolve as "linked via Stripe ID" instantly without
   *  waiting for the next sync. */
  hubspot_company_id?: string;
  hubspot_link_source?: "stripe_id" | "email_fallback" | "none";
  hubspot_link_refreshed_at?: string;
  hubspot_link_refreshed_by?: string;
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

/** Sentinel keys exposed for callers that want to surface ONLY a
 *  CSM-related patch without disturbing the interval override (or vice
 *  versa). */
type FieldKey = keyof CustomerOverride;

export async function setOverride(
  workspaceId: string,
  patch: CustomerOverride
): Promise<OverrideMap> {
  const map = { ...(await loadOverrides()) };
  const current: CustomerOverride = { ...(map[workspaceId] ?? {}) };

  // Per-field semantics: an explicit `undefined` clears the field; an
  // omitted key leaves it untouched. The PUT path on the API routes
  // passes only the fields the caller wants to update, so omission is
  // the common case here.
  const applyField = <K extends FieldKey>(key: K) => {
    if (key in patch) {
      const value = patch[key];
      if (value === undefined || value === "") {
        delete current[key];
      } else {
        current[key] = value as CustomerOverride[K];
      }
    }
  };
  applyField("interval");
  applyField("customer_success_manager");
  applyField("customer_success_manager_email");
  applyField("csm_refreshed_at");
  applyField("csm_refreshed_by");
  applyField("lifecycle_stage");
  applyField("lifecycle_stage_updated_at");
  applyField("lifecycle_stage_updated_by");
  applyField("hubspot_company_id");
  applyField("hubspot_link_source");
  applyField("hubspot_link_refreshed_at");
  applyField("hubspot_link_refreshed_by");
  // field_overrides is a bag — patches MERGE with the existing bag
  // rather than replace it, so a single-field edit doesn't wipe out
  // every prior mapped-field override.
  if ("field_overrides" in patch) {
    const incoming = patch.field_overrides;
    if (!incoming) {
      delete current.field_overrides;
    } else {
      current.field_overrides = { ...(current.field_overrides ?? {}), ...incoming };
    }
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
  // Generic mapped-field overrides — apply each entry to the
  // matching Customer field by name. Skips unknown keys defensively
  // (a typo in the bag shouldn't break the customer load).
  const fromBag = ov.field_overrides ?? {};
  const baseCustomer: Customer = {
    ...customer,
    interval: ov.interval ?? customer.interval,
    customer_success_manager:
      ov.customer_success_manager ?? customer.customer_success_manager,
    customer_success_manager_email:
      ov.customer_success_manager_email ??
      customer.customer_success_manager_email,
    // HubSpot link overrides — when set, trump the sync snapshot.
    // Lets the "Re-resolve via Stripe ID" button flip the link badge
    // green and unblock the write paths (CSM refresh, post-note) the
    // moment the user clicks, instead of waiting for the next sync.
    hubspot_company_id:
      ov.hubspot_company_id ?? customer.hubspot_company_id,
    hubspot_link_source:
      ov.hubspot_link_source ?? customer.hubspot_link_source,
  };
  // Spread bag values onto the customer. Each entry's `value`
  // replaces the corresponding Customer field; null clears it. Type
  // erasure is intentional — Customer has many string-typed fields
  // and we trust the writer (the edit endpoint) to validate.
  const withBag = baseCustomer as Customer & Record<string, unknown>;
  for (const [key, entry] of Object.entries(fromBag)) {
    if (entry && Object.prototype.hasOwnProperty.call(baseCustomer, key)) {
      withBag[key] = entry.value;
    } else if (entry) {
      // Field isn't on Customer (unknown / renamed). Stash on the
      // record anyway so a UI that reads it via index still sees the
      // value — better than silent loss.
      withBag[key] = entry.value;
    }
  }
  return withBag as Customer;
}

/** Returns the raw override entry for a workspace, if any. Lets the
 *  detail panel render the "live" pill + timestamp without re-doing
 *  the override lookup itself. */
export function getOverride(
  workspaceId: string | null | undefined,
  overrides: OverrideMap
): CustomerOverride | null {
  if (!workspaceId) return null;
  return overrides[workspaceId] ?? null;
}

/**
 * Convert a HubSpot owner email into the internal CSM identifier
 * shape Metabase q10600 uses (TitleCase + underscores):
 *
 *   olivia.chen@beehiiv.com           → Olivia_Chen
 *   haas.cavazos@beehiiv.com          → Haas_Cavazos
 *   jacob+test.perry@beehiiv.com      → Jacob_Test_Perry
 *
 * Matching q10600's convention matters because the CSM filter
 * dropdown is built from a Set of distinct identifiers; an override
 * value like "haas_cavazos" (all-lowercase) would otherwise sit
 * alongside snapshot values like "Olivia_Carney" instead of
 * collapsing into the same entry as future Metabase rows.
 */
export function ownerEmailToCsmId(email: string): string {
  const localPart = email.split("@", 1)[0] ?? email;
  return localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("_");
}
