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
  /** Total send events (`sum(is_send)`). Added for the D&C-aligned
   *  Deliverability Snapshot tile — five of the seven D&C ratios use
   *  `sent` as the denominator. The existing pillar-scoring rules
   *  keep computing rates off `deliv` because their thresholds were
   *  tuned against delivered; the snapshot uses `sent` per the D&C
   *  spec instead. */
  sent: number;
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
  /** Unsubscribe count from Postgres over the same lookback window.
   *  Sourced separately from the ClickHouse funnel row because
   *  unsubscribe events aren't emitted into the sendgrid stream —
   *  the customer's action lives on the `subscriptions` row's
   *  `unsubscribed_at` timestamp. Zero when the lookup fails
   *  (fail-open); the tile shows "—" for unsubscribe rate in that
   *  case rather than a misleading 0%. */
  unsubs: number;
}

/**
 * D&C-aligned Deliverability Snapshot — a fixed 7-metric summary that
 * mirrors the "Thresholds applied" table used by the deliverability-
 * quick-screen and enterprise-upgrade-prescreening skills. Deliberately
 * separate from the tunable pillar scoring: the snapshot's thresholds
 * are fixed because D&C treats them as the industry-standard flag lines,
 * and every one uses the denominators the skills document (sent for
 * five of them, delivered for open + spam). Assembled in
 * `computeDeliverabilitySnapshot` in rules.ts; does NOT contribute
 * directly to pillar verdicts.
 */
export type DeliverabilitySnapshotStatus =
  | "clean"
  | "flagged"
  | "low_volume"
  | "no_data";

export interface DeliverabilitySnapshotRow {
  key:
    | "open_rate"
    | "delivery_rate"
    | "hard_bounce_rate"
    | "soft_bounce_rate"
    | "unsubscribe_rate"
    | "spam_rate"
    | "deferral_rate";
  label: string;
  /** Human-readable formula, matches the D&C spec verbatim. */
  formula: string;
  /** Computed ratio (0–1). Null when the denominator is 0 (or when the
   *  unsubscribe query failed for the unsubscribe row). */
  value: number | null;
  /** Flag threshold as a ratio (0–1). */
  threshold: number;
  /** True when `value` meets or breaches the flag threshold. False when
   *  clean; null when `value` is null (undefined signal, don't render
   *  a chip). */
  flagged: boolean | null;
}

export interface DeliverabilitySnapshot {
  window_days: number;
  sent: number;
  delivered: number;
  status: DeliverabilitySnapshotStatus;
  rows: DeliverabilitySnapshotRow[];
  /** Count of rows with `flagged: true` — used by the tile header for
   *  the "N of 7 flagged" summary chip. */
  flagged_count: number;
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
  | "composite_complaint_threshold";

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

  /** D&C-aligned 7-metric snapshot rendered as a summary tile above
   *  the pillar cards. Fixed thresholds, not scored into pillar
   *  verdicts. See `computeDeliverabilitySnapshot` in rules.ts. */
  deliverability_snapshot: DeliverabilitySnapshot;

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
