import type { Customer } from "../types";

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
    company_engagement: (row.company_engagement as string | null) ?? null,
    customer_success_manager:
      (row.customer_success_manager as string | null) ?? null,
    customer_success_manager_email:
      (row.customer_success_manager_email as string | null) ?? null,
    property_company_status:
      (row.property_company_status as string | null) ?? null,
    property_main_contact: (row.property_main_contact as string | null) ?? null,
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
      (row.property_risk_level_csm_ as string | null) ??
      (row.property_risk_level as string | null) ??
      null,
    property_risk_level_detail:
      (row.property_risk_level_detail_csm_ as string | null) ?? null,
    property_customer_goals:
      (row.property_customer_goals_csm_ as string | null) ?? null,
    property_customer_goals_detail:
      (row.property_customer_goals_detail_csm_ as string | null) ?? null,
    property_csm_owner_change_date:
      (row.property_csm_owner_change_date as string | null) ?? null,
    property_notes_last_contacted:
      (row.property_notes_last_contacted as string | null) ?? null,
    property_agency_talent:
      (row.property_agency_talent as string | null) ?? null,
    next_invoice: (row.next_invoice as string | null) ?? null,
    have_started_t4_recommendations:
      (row.have_started_t4_recommendations as boolean | null) ?? null,
    completed_t4_recommendations:
      (row.completed_t4_recommendations as boolean | null) ?? null,
  };
}
