/**
 * D&C Upgrade Analysis — public types.
 *
 * These types are the contract between the engine, the KV store, the
 * API endpoint, and the eventual UI panel. Kept client-safe (no
 * server-only imports) so any component can import the report shape.
 *
 * The 9-pillar structure comes from D&C's manual investigation skill;
 * v1 implements pillars 1–4, 6, and 8. Pillars 5 (domain recon) and 7
 * (link endpoint analysis) are deferred — see the plan.
 */

// ─── Pillar keys ─────────────────────────────────────────────────────────

/** MVP pillars — six of the nine D&C investigates. Numbering follows
 *  the skill's original ordering; missing entries (5, 7) are v2. */
export type PillarKey =
  | "identity" // Pillar 1
  | "acquisition" // Pillar 2
  | "funnel" // Pillar 3
  | "engagement" // Pillar 4
  | "provider" // Pillar 6
  | "network"; // Pillar 8

export type PillarScore = "green" | "amber" | "red";

/** Overall verdict for the account. `clear` = safe to proceed with
 *  outreach; `review_needed` = amber signals a D&C should confirm;
 *  `hold` = red — do not upgrade without an explicit D&C review. */
export type OverallVerdict = "clear" | "review_needed" | "hold";

// ─── Pillar counter shapes ───────────────────────────────────────────────

/** Pillar 1 — publications row + inferred plan signals. */
export interface IdentityCounters {
  pub_id: string;
  org_id: string;
  name: string | null;
  created_at: string | null;
  double_opt_required: boolean | null;
  enable_signup_confirmation: boolean | null;
  private: boolean | null;
  require_subscriber_approval: boolean | null;
  white_labeled_at: string | null;
  deleted_at: string | null;
  /** Days between `created_at` and now — a very young account with
   *  a large send volume is a signal the network read cares about. */
  age_days: number | null;
}

/** Pillar 2 — how subscribers came in + opt-in coverage. */
export interface AcquisitionChannelRow {
  channel:
    | "import"
    | "api"
    | "acquisition_cart"
    | "recommendation"
    | "embed"
    | "integration"
    | "referral"
    | "organic_form";
  status: string;
  n: number;
}

export interface AcquisitionCounters {
  channels: AcquisitionChannelRow[];
  /** Total subs across all channels for percentage math. */
  total_subs: number;
  /** Percentage of subs that have an `opt_in_at` timestamp. Zero
   *  across the base = beehiiv holds no consent artifact. */
  opt_in_coverage_pct: number;
  /** Weekly injection cadence — helps spot list dumps vs steady
   *  acquisition. Reported over the past ~60 weeks. */
  weekly_injections: Array<{ week: string; added: number }>;
  /** Import filenames + API-key labels for the forensic step —
   *  operator networks tend to reuse tokens like "bought_broker",
   *  "list_purchase_v2", etc. Interpreted by rules.ts. */
  import_filenames: string[];
  api_key_names: string[];
}

/** Pillars 3 + 4 — combined funnel counters over the lookback window. */
export interface FunnelCounters {
  window_days: number;
  rows_evt: number;
  deliv: number;
  opens: number;
  v_opens: number;
  mach_opens: number;
  ua_mach: number;
  clicks: number;
  v_clicks: number;
  deferred: number;
  soft_b: number;
  hard_b: number;
  spam: number;
  uniq_subs: number;
}

/** Pillar 6 — provider concentration + rejection reason class breakdown. */
export interface ProviderRow {
  dom: string;
  deliv: number;
  spam: number;
  spam_pct: number;
  defer_pct: number;
}

export interface DeferralReasonRow {
  reason_class:
    | "spamcop"
    | "spamhaus"
    | "cloudmark"
    | "blocked/blocklist"
    | "spam-content"
    | "greylist"
    | "other";
  ev: "deferred" | "bounce";
  n: number;
}

export interface ProviderCounters {
  window_days: number;
  providers: ProviderRow[];
  /** Real-rejection reason classes (Kumo `0.0.0.0` excluded upstream). */
  deferral_reasons: DeferralReasonRow[];
  /** Kumo queue-delay share of ALL deferrals — surfaced separately
   *  so a headline "20% deferred" that's mostly Kumo doesn't get
   *  read as a provider-rejection crisis. */
  kumo_share_of_deferrals: number;
}

/** Pillar 8 — org flags + sibling org signal. */
export interface OrgFlagRow {
  organization_id: string;
  flag: string;
  created_at: string;
  deleted_at: string | null;
}

export interface NetworkCounters {
  /** Flags on THIS org. Includes historically-cleared flags
   *  (`deleted_at != null`) for the audit trail. */
  org_flags: OrgFlagRow[];
  /** True iff any current (non-`deleted_at`) `aup_prohibited_use`
   *  flag exists on this org. The most consequential single
   *  network signal — corroborates a "do not scale" verdict. */
  aup_prohibited_use_active: boolean;
  /** `ip_already_used` is a multi-account fingerprint. Presence is
   *  a raised eyebrow; corroborate with Slack search hits. */
  ip_already_used_active: boolean;
  /** True when we couldn't map the operator network through
   *  Postgres joins (there's no clean owner→org table in the
   *  replica). The UI reminds the user Slack search is the
   *  authoritative source for network mapping. */
  network_map_incomplete: true;
  /** Snapshot Spamhaus DBL lookups for the publication's resolved
   *  sending domains at scan time. Empty when no domain could be
   *  resolved (the pillar renders "not checked" in that case). A
   *  listing on any domain is a hold-verdict contributor via the
   *  spamhaus_listed rule; unknown status is treated as amber, not
   *  red, so DNS glitches don't misclassify.
   *
   *  Persisted with the scan result so re-opening a cached report
   *  shows the same snapshot; a Re-run (force) requeries. */
  spamhaus_checks: SpamhausDblCheck[];
}

/** Client-safe mirror of the SpamhausCheck shape from
 *  `src/lib/integrations/spamhaus.ts`. Re-declared here (instead of
 *  imported) because this types module is used by client components
 *  that must not pull in `node:dns`. Kept structurally identical so
 *  the pillar can assign the integration result directly. */
export interface SpamhausDblCheck {
  domain: string;
  status: "clean" | "listed" | "unknown";
  code: string | null;
  category:
    | "spam"
    | "phish"
    | "malware"
    | "botnet"
    | "redirector"
    | "abused_legit"
    | "bad_query"
    | "unknown"
    | null;
  reason: string | null;
}

// ─── Slack signals (populated by Pillar-8 sibling; see slack-search.ts) ──

export interface SlackSearchHit {
  channel_id: string;
  channel_name?: string;
  ts: string;
  permalink: string;
  snippet: string;
  matched_term: string;
}

// ─── Escalation ──────────────────────────────────────────────────────────

/** Reason enum — every escalation reason surfaced to the UI must map
 *  to one of these. Adding a new reason = extend here + write the
 *  rule in engines/upgrade-analysis/rules.ts. */
export type EscalationReason =
  | "pillar_red"
  | "multiple_amber"
  | "aup_prohibited_use"
  | "slack_prior_decision"
  | "composite_complaint_threshold"
  /** At least one sending domain is on the Spamhaus DBL. Category
   *  determines severity via the spamhaus_botnet_treatment config. */
  | "spamhaus_dbl_listed";

export interface EscalationVerdict {
  needed: boolean;
  /** Human-readable, one per rule that tripped. */
  reasons: Array<{
    code: EscalationReason;
    detail: string;
  }>;
}

// ─── Full report ─────────────────────────────────────────────────────────

export interface UpgradeAnalysisReport {
  pub_id: string;
  org_id: string;
  generated_at: string;
  /** Session email of whoever triggered the scan. `null` for cron
   *  runs — cron isn't part of MVP but the field is preserved so a
   *  future scheduled sweep can populate it as `"cron"`. */
  triggered_by: string | null;

  pillars: {
    identity: IdentityCounters;
    acquisition: AcquisitionCounters;
    funnel: FunnelCounters;
    engagement: FunnelCounters; // Same row shape; engagement derived from funnel
    provider: ProviderCounters;
    network: NetworkCounters;
  };

  slack_signals: SlackSearchHit[];

  pillar_scores: Record<PillarKey, PillarScore>;
  escalation: EscalationVerdict;
  overall: OverallVerdict;

  /** Freeform bag preserved for the UI — raw counts, computed
   *  derivatives, etc. Kept opaque to the scoring rules so we can
   *  add UI-only fields without changing the report contract. */
  raw_counters: Record<string, unknown>;
}

/** Persisted blob shape — the report + a scan timestamp used by the
 *  freshness guard in the /scan endpoint. */
export interface StoredUpgradeAnalysis {
  report: UpgradeAnalysisReport;
  last_scanned_at: string;
}
