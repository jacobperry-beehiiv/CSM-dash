import type { Customer } from "../types";

/**
 * Coerce a Metabase-typed cell into a clean string|null. Q10600 (and
 * HubSpot upstream) occasionally returns boolean / numeric values
 * for properties typed as strings on our side — e.g.
 * property_customer_goals coming back as `false` when no goal is
 * set. Without coercion the boolean flows through the `as string`
 * cast unchanged and the UI renders the literal word "false". Use
 * this at every string-typed field boundary so the dashboard never
 * has to defensively re-handle non-strings downstream.
 */
function asStringCell(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Shapes a raw Metabase q10600 row into the Customer type the dashboard uses.
 * Used by both the live Metabase loader and the snapshot loader (which stores
 * raw rows verbatim).
 */
export function metabaseRowToCustomer(
  row: Record<string, unknown>
): Customer {
  return {
    workspace_id: (row.workspace_id as string | null) ?? null,
    workspace_name: (row.workspace_name as string | null) ?? null,
    company_name: (row.company_name as string | null) ?? null,
    owner_email: (row.owner_email as string | null) ?? null,
    mrr: Number(row.mrr) || 0,
    arr: Number(row.arr) || 0,
    active_subs:
      (row.approx_active_subs as number | null) ??
      (row.active_subs as number | null) ??
      null,
    max_subscriptions: (row.max_subscriptions as number | null) ?? null,
    renewal_date:
      (row.renewal_date as string | null) ??
      (row.contract_renewal as string | null) ??
      null,
    contract_renewal: (row.contract_renewal as string | null) ?? null,
    company_engagement: (row.company_engagement as string | null) ?? null,
    customer_success_manager:
      (row.customer_success_manager as string | null) ?? null,
    customer_success_manager_email:
      (row.customer_success_manager_email as string | null) ?? null,
    property_company_status:
      (row.property_company_status as string | null) ?? null,
    property_main_contact: asStringCell(row.property_main_contact),
    stripe_plan: (row.stripe_plan as string | null) ?? null,
    interval:
      (row.interval as string | null) ??
      (row.contract_renewal_interval as string | null) ??
      null,
    last_send: (row.last_send as string | null) ?? null,
    last_log_in: (row.last_log_in as string | null) ?? null,
    mon_since_1st_ent: (row.mon_since_1st_ent as number | null) ?? null,
    percent_of_max_subs: (row.percent_of_max_subs as number | null) ?? null,
    direct_sponsorships_enabled:
      (row.direct_sponsorships_enabled as boolean | null) ?? null,
    ad_placement: (row.ad_placement as boolean | null) ?? null,
    grew_via_boost: (row.grew_via_boost as boolean | null) ?? null,
    monetization_via_boost:
      (row.monetization_via_boost as boolean | null) ?? null,
    stripe_customer_id: (row.stripe_customer_id as string | null) ?? null,
    property_timezone: (row.property_timezone as string | null) ?? null,
    property_risk_level:
      asStringCell(row.property_risk_level_csm_) ??
      asStringCell(row.property_risk_level),
    property_risk_level_detail: asStringCell(
      row.property_risk_level_detail_csm_
    ),
    property_customer_goals: asStringCell(
      row.property_customer_goals_csm_
    ),
    property_customer_goals_detail: asStringCell(
      row.property_customer_goals_detail_csm_
    ),
    property_csm_owner_change_date:
      (row.property_csm_owner_change_date as string | null) ?? null,
    property_notes_last_contacted:
      (row.property_notes_last_contacted as string | null) ?? null,
    property_agency_talent:
      (row.property_agency_talent as string | null) ?? null,
    property_customer_folder:
      (row.property_customer_folder as string | null) ?? null,
    next_invoice: (row.next_invoice as string | null) ?? null,
    have_started_t4_recommendations:
      (row.have_started_t4_recommendations as boolean | null) ?? null,
    completed_t4_recommendations:
      (row.completed_t4_recommendations as boolean | null) ?? null,
    // q10600 surfaces the HubSpot company record ID under a few possible
    // column names depending on which HubSpot table the question joins
    // against. Accept all known variants — the sync-time enrichment step
    // (src/lib/integrations/hubspot.ts) requires this to call the
    // HubSpot batch-read endpoint.
    hubspot_company_id:
      (row.hubspot_company_id as string | null) ??
      (row.hs_object_id as string | null) ??
      (row.property_hs_object_id as string | null) ??
      (row.company_id_hubspot as string | null) ??
      null,
    // Populated by sync.ts after HubSpot enrichment — not present on raw
    // Metabase rows. Keep here so snapshot.enc.json round-trips cleanly
    // through this mapper after enrichment writes it.
    last_activity_at: (row.last_activity_at as string | null) ?? null,
    last_activity_source:
      (row.last_activity_source as string | null) ?? null,
    // Set by scripts/sync.ts after HubSpot enrichment; pass through
    // unchanged when present so re-mapping the snapshot keeps the field.
    hubspot_contacts:
      (row.hubspot_contacts as
        | import("../types").HubSpotContactRef[]
        | null
        | undefined) ?? null,
    // ─── HubSpot link confidence (Stripe-ID resolver) ───────────────
    // Stamped by scripts/sync.ts (`hubspot_link_source` / `hubspot_link_warning`)
    // after the Stripe-ID-first HubSpot resolver runs. Pass through
    // verbatim so the link badge in customer-detail-panel sees the
    // resolved state — without these lines the mapper silently drops
    // them and every row renders as "🔴 No HubSpot link" regardless
    // of what the sync actually resolved.
    hubspot_link_source:
      (row.hubspot_link_source as
        | "stripe_id"
        | "email_fallback"
        | "none"
        | undefined) ?? undefined,
    hubspot_link_warning:
      (row.hubspot_link_warning as string | null | undefined) ?? null,
    // ─── Multi-month renewals (q23101 enrichment) ───────────────────
    // Months between billing triggers, set by scripts/sync.ts when
    // q23101 returns a row for this customer. Drives the Renewals
    // tab's cadence bucketing — without it, quarterly / semi-annual /
    // biennial customers all mis-bucket as Monthly (their q10600
    // `interval` reads "month" even though the trigger is N months
    // apart).
    interval_count:
      typeof row.interval_count === "number"
        ? row.interval_count
        : typeof row.interval_count === "string"
          ? Number(row.interval_count) || null
          : null,
  };
}
