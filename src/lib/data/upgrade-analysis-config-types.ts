/**
 * Client-safe types + defaults for the D&C Upgrade Analysis threshold
 * registry. Same split pattern as wins-config-types.ts — the
 * server-only KV store lives in upgrade-analysis-config.ts.
 *
 * Every number here comes from the interpretation-guardrails cheat
 * sheet in the upgrade-analysis skill:
 *   scratchpad/upgrade-analysis/references/interpretation-guardrails.md
 * (see "Thresholds cheat-sheet" section for the healthy/watch/critical
 * bands). Overriding via /api/upgrade-analysis/config lets D&C tune
 * without a code change — the scorecard is *deliberately* deterministic
 * so a tuning decision is auditable.
 *
 * Percentages are expressed as decimals (0.001 = 0.1%) to match how
 * the rules read them; the settings UI renders them as percentages
 * with the `pct_absolute` unit.
 */

// ─── Complaint / spam thresholds (per-send rate) ─────────────────────────

export interface ComplaintThresholds {
  /** Blended (all-provider) complaint rate. Watch = amber, critical = red. */
  blended_watch: number;
  blended_critical: number;
  /** Comcast spike red-line. Comcast is complaint-led + has directly
   *  triggered beehiiv-wide Comcast blocks in the past — a per-provider
   *  spike beats blended for early-warning value. */
  comcast_red: number;
  /** Ratio of provider rate to blended that promotes an amber even
   *  when the provider is not Comcast. e.g. 2.5 = a provider running
   *  2.5x the blended rate is elevated. */
  provider_ratio_amber: number;
  /** Composite complaint enforcement threshold — the D&C-side floor
   *  at which action is taken regardless of engagement. Doubles as
   *  an absolute-count sanity floor (see `enforcement_abs_floor`). */
  enforcement_rate: number;
  enforcement_abs_floor: number;
}

// ─── Deferral / rejection thresholds (rate on real rejections, ex-Kumo) ──

export interface DeferralThresholds {
  /** Real-rejection rate bands. Kumo `0.0.0.0` deferrals are stripped
   *  before this rate is computed — see rules.classifyDeferrals. */
  watch: number;
  critical: number;
  /** Hard-bounce rate red-line. */
  hard_bounce_red: number;
  /** Unsubscribe-per-send band. */
  unsub_watch: number;
  unsub_critical: number;
}

// ─── Engagement / hollow-list thresholds (verified clicks only) ──────────

export interface EngagementThresholds {
  /** Verified click rate — engagement truth. Below this the list is
   *  considered hollow (opens likely MPP-inflated). */
  hollow_verified_click_rate: number;
  /** Verified CTOR — healthy floor. */
  ctor_healthy: number;
}

// ─── Volume / trigger thresholds ─────────────────────────────────────────

export interface VolumeThresholds {
  /** Fraction of the pub's max subscriber cap at which upgrade-analysis
   *  is *relevant*. Matches src/app/am/page.tsx:35 `ENT_UTIL_THRESHOLD`.
   *  Currently only surfaced as UI copy — no auto-sweep in MVP. */
  approaching_cap: number;
  /** Freshness guard on scan results. Below this age, POST /scan
   *  returns the cached report unless `force: true`. */
  freshness_hours: number;
  /** Windows the pillar SQL scans, in days. Kept configurable so D&C
   *  can widen/narrow a lookback without a code change. */
  funnel_window_days: number;
  provider_window_days: number;
  acquisition_weekly_lookback: number;
}

// ─── Escalation rules (structural) ───────────────────────────────────────

export interface EscalationRules {
  /** Any single pillar at this score or worse escalates. Default
   *  "red" — pillar-yellow alone shouldn't escalate. */
  escalate_on_pillar: "red" | "amber";
  /** Multi-amber threshold — if ≥ this many pillars are amber (or
   *  worse), escalate even though no single pillar hit red. */
  amber_pillars_to_escalate: number;
  /** When Slack search hits any term in this list, escalate. Case-
   *  insensitive substring match against the message snippet. */
  slack_escalation_terms: string[];
}

// ─── Full registry ───────────────────────────────────────────────────────

export interface UpgradeAnalysisConfig {
  complaints: ComplaintThresholds;
  deferrals: DeferralThresholds;
  engagement: EngagementThresholds;
  volume: VolumeThresholds;
  escalation: EscalationRules;
}

/** Shipped defaults, straight from the interpretation-guardrails
 *  cheat-sheet. */
export const DEFAULT_UPGRADE_ANALYSIS_CONFIG: UpgradeAnalysisConfig = {
  complaints: {
    blended_watch: 0.001, // 0.10%
    blended_critical: 0.003, // 0.30%
    comcast_red: 0.0009, // ~0.09%
    provider_ratio_amber: 2.5,
    enforcement_rate: 0.0035, // 0.35% composite floor
    enforcement_abs_floor: 2000,
  },
  deferrals: {
    watch: 0.05,
    critical: 0.25,
    hard_bounce_red: 0.005, // 0.5%
    unsub_watch: 0.005,
    unsub_critical: 0.01,
  },
  engagement: {
    hollow_verified_click_rate: 0.005, // 0.5%
    ctor_healthy: 0.05, // 5%
  },
  volume: {
    approaching_cap: 0.75,
    freshness_hours: 24,
    funnel_window_days: 30,
    provider_window_days: 30,
    acquisition_weekly_lookback: 60,
  },
  escalation: {
    escalate_on_pillar: "red",
    amber_pillars_to_escalate: 2,
    // Terms fed to the escalation rule that inspects Slack matches
    // for a prior D&C decision. When any hit's snippet contains one
    // of these (case-insensitive; matched via
    // `computeEscalation` → `slack_prior_decision`), the panel adds
    // an escalation reason. Values are D&C's own vocabulary from
    // the Skill Logic Breakdown — extend from the Threshold Editor
    // settings page if D&C invents a new phrase.
    slack_escalation_terms: [
      "do not upgrade",
      "do not scale",
      "offboard",
      "offboarded",
      "aup_prohibited_use",
      "reactivate",
      "list wash",
      "already offboarded",
      "blocked",
      "suspended",
      "abuse",
      "spam complaint",
    ],
  },
};

// ─── Merge helper ────────────────────────────────────────────────────────

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

/** Deep-merge a Partial onto the defaults so admins can override any
 *  subset — same shape as mergeWinsConfig. Missing keys fall through. */
export function mergeUpgradeAnalysisConfig(
  overrides: DeepPartial<UpgradeAnalysisConfig> | null | undefined
): UpgradeAnalysisConfig {
  if (!overrides) return DEFAULT_UPGRADE_ANALYSIS_CONFIG;
  return {
    complaints: {
      ...DEFAULT_UPGRADE_ANALYSIS_CONFIG.complaints,
      ...(overrides.complaints ?? {}),
    },
    deferrals: {
      ...DEFAULT_UPGRADE_ANALYSIS_CONFIG.deferrals,
      ...(overrides.deferrals ?? {}),
    },
    engagement: {
      ...DEFAULT_UPGRADE_ANALYSIS_CONFIG.engagement,
      ...(overrides.engagement ?? {}),
    },
    volume: {
      ...DEFAULT_UPGRADE_ANALYSIS_CONFIG.volume,
      ...(overrides.volume ?? {}),
    },
    escalation: {
      ...DEFAULT_UPGRADE_ANALYSIS_CONFIG.escalation,
      ...(overrides.escalation ?? {}),
    },
  };
}

export type UpgradeAnalysisConfigOverrides = DeepPartial<UpgradeAnalysisConfig>;
