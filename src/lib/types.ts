// ─── Book of business row (Metabase question 10600 + CSM-properties CSV) ──
export interface Customer {
  workspace_id: string | null;
  workspace_name: string | null;
  company_name: string | null;
  owner_email: string | null;
  mrr: number;
  arr: number;
  active_subs: number | null;
  max_subscriptions: number | null;
  renewal_date: string | null;
  company_engagement: string | null;
  customer_success_manager: string | null;
  customer_success_manager_email?: string | null;
  property_company_status: string | null;
  property_main_contact: string | null;
  stripe_plan: string | null;
  interval: string | null;
  /**
   * Months between billing triggers, sourced from Stripe via Metabase
   * q23101 (multi-month renewal cohort) at sync time. Stamped only on
   * customers whose cadence isn't a vanilla monthly or annual:
   *   3   → quarterly
   *   4   → every 4 months
   *   6   → semi-annual
   *   12  → annual (set explicitly when the multi-month query
   *         surfaces them, but the default annual customers
   *         coming from q10600 carry only `interval: "year"` and
   *         leave this null)
   *   24  → biennial
   *   ... → every N months
   *
   * Drives the cadence bucket on the Renewals tab via
   * intervalBucket() so the dropdown can offer Quarterly /
   * Semi-annual / Biennial as distinct filters instead of
   * lumping everything non-monthly into one bucket.
   *
   * Null when q23101 returned no row for this customer (the
   * common case — most accounts are monthly or annual).
   */
  interval_count?: number | null;
  last_send: string | null;
  last_log_in: string | null;
  mon_since_1st_ent: number | null;
  percent_of_max_subs: number | null;
  direct_sponsorships_enabled: boolean | null;
  ad_placement: boolean | null;
  grew_via_boost: boolean | null;
  monetization_via_boost: boolean | null;
  stripe_customer_id?: string | null;

  // ─── Extended fields populated when source = CSV (HubSpot-derived properties)
  property_timezone?: string | null;
  property_risk_level?: string | null;
  property_risk_level_detail?: string | null;
  property_customer_goals?: string | null;
  property_customer_goals_detail?: string | null;
  property_csm_owner_change_date?: string | null;
  property_notes_last_contacted?: string | null;
  property_agency_talent?: string | null;
  next_invoice?: string | null;
  have_started_t4_recommendations?: boolean | null;
  completed_t4_recommendations?: boolean | null;

  // ─── HubSpot direct-API enrichment (set by scripts/sync.ts) ──────────
  // The company's HubSpot record ID, pulled from Metabase q10600. Required
  // by the sync-time enrichment step in src/lib/integrations/hubspot.ts.
  hubspot_company_id?: string | null;
  // Most-recent of HubSpot's notes_last_activity_date,
  // notes_last_contacted, and hs_last_sales_activity_timestamp — captures
  // emails / calls / meetings / notes across ALL contacts at the company
  // rather than just the narrow "manual contact note" the legacy field
  // covered. ISO date string, set when sync.ts ran with HUBSPOT_ACCESS_TOKEN.
  last_activity_at?: string | null;
  /** Which raw field won the max() that produced last_activity_at. Tooltip. */
  last_activity_source?: string | null;
  /**
   * Contacts whose primary associated company in HubSpot is this customer's
   * company. Populated at sync time by src/lib/integrations/hubspot.ts.
   * The contact with is_primary=true is the company's pinned primary contact
   * (hs_primary_contact_id). Used by the customer detail panel to show
   * "who at this company is HubSpot tracking?" beyond just owner_email.
   */
  hubspot_contacts?: HubSpotContactRef[] | null;
  /**
   * How sync.ts resolved this row's HubSpot company link.
   *   "stripe_id"      — resolved via the stripe_customer_id property
   *                      on the HubSpot company (primary path).
   *   "email_fallback" — Stripe-ID lookup returned nothing, so we
   *                      walked owner_email → contact → primary
   *                      company instead.
   *   "none"           — neither resolved; row has no HubSpot link.
   *
   * Surfaced in the detail panel so a CSM can tell at a glance how
   * trustworthy the link is (and whether they need to add the Stripe
   * ID to the HubSpot company record).
   */
  hubspot_link_source?: "stripe_id" | "email_fallback" | "none";
  /**
   * Set when the resolver detected a conflict during sync — e.g., the
   * q10600 `hubspot_company_id` column doesn't match what the
   * Stripe-ID lookup returned (likely a HubSpot company merge). UI
   * surfaces this as an amber "Link mismatch" badge with the
   * conflicting IDs in the tooltip.
   */
  hubspot_link_warning?: string | null;
}

export interface HubSpotContactRef {
  id: string;
  email: string | null;
  name: string | null;
  job_title: string | null;
  last_activity_at: string | null;
  is_primary: boolean;
}

export interface CustomerWithMetrics extends Customer {
  open_rate?: number | null;
  ctr?: number | null;
  utilization_pct: number | null;
}

// ─── Deliverability ────────────────────────────────────────────────────
export interface PostMetricsRow {
  post_id: string;
  publication_id: string;
  newsletter: string;
  organization_id: string;
  workspace_name: string;
  sent_date: string;
  subject: string;
  sent: number;
  delivered: number;
  delivery_rate: number;
  opens: number;
  open_rate: number;
  clicks: number;
  ctr: number;
  hard_bounces: number;
  hard_bounce_rate: number;
  soft_bounces: number;
  soft_bounce_rate: number;
  unsubs: number;
  unsub_rate: number;
  spam_reports: number;
  spam_rate: number;
}

export type RedFlagSeverity = "critical" | "warning";

export interface RedFlag {
  code: string;
  severity: RedFlagSeverity;
  metric: string;
  value: number;
  threshold: number;
  message: string;
}

export interface DeliverabilityAlert {
  post: PostMetricsRow;
  flags: RedFlag[];
  csm: string | null;
  /** Set when a CSM has explicitly "cleared" this send (acknowledged
   *  or triaged). Hidden from the active alerts list by default; the
   *  panel offers a "Show cleared" toggle to bring them back. */
  cleared?: {
    cleared_at: string;
    cleared_by?: string | null;
    reason?: string | null;
  } | null;
}

// ─── At-risk ──────────────────────────────────────────────────────────
export type RiskFlagCode = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

export interface RiskFlag {
  code: RiskFlagCode;
  label: string;
  detail: string;
}

export interface AtRiskAccount {
  customer: Customer;
  flags: RiskFlag[];
  priority_score: number;
  recommended_action: string;
  draft_outreach?: string;
}

// ─── Ad gap ───────────────────────────────────────────────────────────
export interface AdGapPublicationRow {
  publication_id: string;
  publication_name: string;
  subscribers: number | null;
  sends_in_period: number;
  has_ad_profile: boolean;
  ads_accepted: number;
  ads_canceled: number;
  ads_missed: number;
  fill_rate: number | null;
  actual_payout_dollars: number;
  estimated_payout_dollars: number;
  avg_actual_per_ad_dollars: number | null;
}

export interface AdGapReport {
  organization_id: string;
  organization_name: string;
  owner_email: string | null;
  total_subscribers: number;
  publications: AdGapPublicationRow[];
  portfolio_actual_dollars: number;
  portfolio_potential_at_full_fill_dollars: number;
  zero_ad_sending_pubs: AdGapPublicationRow[];
}

export type DataSource = "metabase" | "snapshot";

export type Segment = "enterprise" | "growth" | "all";
