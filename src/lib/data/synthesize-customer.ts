import type { Customer } from "../types";

/**
 * Construct a minimal `Customer` shape for rows that don't exist in
 * the customer book (q10600). Used by Past Due + Approaching
 * Enterprise panels when `customerByStripeId.get(...)` misses — non-
 * enterprise / self-serve accounts surface in those billing-side
 * Metabase questions but aren't always in the book.
 *
 * Without this, the detail-panel expand fell back to a "couldn't
 * resolve" message. With it, the panel renders against whatever data
 * the row already carries — name, email, workspace_id when we have
 * it — and the structured sections (Status / Dates / Contact) just
 * read "—" for missing fields. Notes work as long as a workspace_id
 * was passed through.
 *
 * The Customer type has lots of fields; we default the numerics to 0
 * and the nullable strings to null. Detail-panel sections that key
 * off specific fields (Publications via workspace_id,
 * FeatureUtilization via workspace_id, HubSpot contacts via the
 * `hubspot_contacts` array) all degrade to their own empty states
 * when the data isn't there.
 */
export function synthesizeCustomer(input: {
  workspace_id?: string | null;
  workspace_name?: string | null;
  company_name?: string | null;
  owner_email?: string | null;
  owner_name?: string | null;
  stripe_customer_id?: string | null;
  /** Best-effort: when the row knows the CSM (e.g. PastDueRow), pass
   *  it through so the Contact section shows the right name. */
  customer_success_manager?: string | null;
  customer_success_manager_email?: string | null;
  stripe_plan?: string | null;
  arr?: number | null;
  mrr?: number | null;
  active_subs?: number | null;
  max_subscriptions?: number | null;
  interval?: string | null;
}): Customer {
  return {
    workspace_id: input.workspace_id ?? null,
    workspace_name: input.workspace_name ?? null,
    company_name: input.company_name ?? input.workspace_name ?? null,
    owner_email: input.owner_email ?? null,
    mrr: input.mrr ?? 0,
    arr: input.arr ?? 0,
    active_subs: input.active_subs ?? null,
    max_subscriptions: input.max_subscriptions ?? null,
    renewal_date: null,
    company_engagement: null,
    customer_success_manager: input.customer_success_manager ?? null,
    customer_success_manager_email:
      input.customer_success_manager_email ?? null,
    property_company_status: null,
    property_main_contact: input.owner_name ?? null,
    stripe_plan: input.stripe_plan ?? null,
    interval: input.interval ?? null,
    last_send: null,
    last_log_in: null,
    mon_since_1st_ent: null,
    percent_of_max_subs: null,
    direct_sponsorships_enabled: null,
    ad_placement: null,
    grew_via_boost: null,
    monetization_via_boost: null,
    stripe_customer_id: input.stripe_customer_id ?? null,
  };
}
