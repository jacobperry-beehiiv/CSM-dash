import type { Customer } from "../types";

/**
 * Synthetic test customer for exercising new features against a non-live
 * record. Injected into loadCustomers() so it shows up everywhere a real
 * customer would (account table, profile page, signals stream, drafts
 * modal) — but with safe placeholder values so aggregates aren't moved.
 *
 * Reachable at:
 *   /account/test-workspace
 *
 * Post signals against it with:
 *   POST /api/customer-signals
 *   { workspace_id: "test-workspace", ... }
 *
 * ARR / MRR / subs are deliberately zero so the synthetic row doesn't
 * distort ARR totals or risk-flag counts. The workspace_name is
 * prefixed "[TEST]" so it sorts oddly and is impossible to mistake
 * for a real account in any view.
 */
export const TEST_WORKSPACE_ID = "test-workspace";

export const TEST_CUSTOMER: Customer = {
  workspace_id: TEST_WORKSPACE_ID,
  workspace_name: "[TEST] Test Workspace",
  company_name: "[TEST] Test Workspace",
  owner_email: "test+csm-dash@beehiiv.com",
  mrr: 0,
  arr: 0,
  active_subs: 0,
  max_subscriptions: null,
  renewal_date: null,
  company_engagement: null,
  customer_success_manager: null,
  customer_success_manager_email: null,
  property_company_status: null,
  property_main_contact: "Test Contact",
  stripe_plan: "Enterprise (test)",
  interval: "annual",
  last_send: null,
  last_log_in: null,
  mon_since_1st_ent: null,
  percent_of_max_subs: null,
  direct_sponsorships_enabled: null,
  ad_placement: null,
  grew_via_boost: null,
  monetization_via_boost: null,
  stripe_customer_id: "cus_test_dashboard",
  property_timezone: null,
  property_risk_level: null,
  property_risk_level_detail: null,
  property_customer_goals: null,
  property_customer_goals_detail: null,
  property_csm_owner_change_date: null,
  property_notes_last_contacted: null,
  property_agency_talent: null,
  next_invoice: null,
  have_started_t4_recommendations: null,
  completed_t4_recommendations: null,
  hubspot_company_id: null,
  last_activity_at: null,
  last_activity_source: null,
  hubspot_contacts: null,
};
