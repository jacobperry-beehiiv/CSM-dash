import type {
  WinCategory,
  WinComparisonBasis,
  WinConfidence,
  WinType,
} from "../data/wins-types";
import type { WinsConfig } from "../data/wins-config-types";
import { DEFAULT_WINS_CONFIG } from "../data/wins-config-types";
import type { PublicationMetrics, WeeklyBucket } from "./wins-metrics";

/**
 * Phase 1 rule catalog. Four self-comparison rules from Hayden's
 * scope doc, Appendix A. Each rule is a pure function of the
 * publication's rollup + the current WinsConfig — no HubSpot /
 * Metabase / KV side effects. The wins.ts engine wraps rule hits
 * into full CandidateWin rows (adds workspace_id, csm_name,
 * detection_week, stable win_id).
 *
 * Rule signatures accept an optional `config` param. Callers that
 * don't pass one fall through to DEFAULT_WINS_CONFIG — same
 * behavior as before this refactor. The engine passes the merged
 * KV-override + defaults blob so admins can tune from /settings/wins
 * without a deploy.
 */

/** Historic export name — kept as a re-export of the module-level
 *  defaults so downstream callers (tests, scripts) don't break. New
 *  code should read DEFAULT_WINS_CONFIG from `lib/data/wins-config-types`. */
export { DEFAULT_WINS_CONFIG as WINS_CONFIG };

export interface RuleHit {
  win_type: WinType;
  category: WinCategory;
  headline: string;
  /** Numeric hit value the UI renders — CTOR / open rate / etc. */
  metric_value: number;
  /** What the metric_value beat. Prior best / baseline / streak start. */
  comparison_value: number;
  comparison_basis: WinComparisonBasis;
  confidence: WinConfidence;
  mapped_opportunity: string;
  /** Optional publication-scope context for the wins.ts engine to
   *  carry into the CandidateWin. Rules operate at the publication
   *  level; the store rolls up to the workspace level. */
  publication_id: string;
  publication_name: string | null;
}

function pctString(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Include only weeks whose bucket has fully closed — the current
 *  in-flight week's rate is inherently partial and would blow up
 *  streaks / baselines. Compare bucket.week_start Monday vs.
 *  today's Monday (UTC). */
function completedWeeks(
  buckets: WeeklyBucket[],
  now: Date
): WeeklyBucket[] {
  const day = now.getUTCDay() || 7;
  const currentMondayMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    (day - 1) * 86400000;
  const currentMonday = new Date(currentMondayMs).toISOString().slice(0, 10);
  return buckets.filter((b) => b.week_start < currentMonday);
}

// ─── Rule 1: verified_ctor_record ─────────────────────────────────
// Fires when a publication's most-recent post beats every prior
// CTOR in the lookback window (with a `min_beat_pp` margin). Guards
// against small-list noise via a `min_delivered_on_record` floor.
export function ruleVerifiedCtorRecord(
  pub: PublicationMetrics,
  now: Date = new Date(),
  config: WinsConfig = DEFAULT_WINS_CONFIG
): RuleHit | null {
  const cfg = config.verified_ctor_record;
  const cutoffMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    cfg.lookback_days * 86400000;
  const cutoffYmd = new Date(cutoffMs).toISOString().slice(0, 10);

  const inWindow = pub.posts.filter(
    (p) => p.sent_date >= cutoffYmd && p.ctor != null
  );
  if (inWindow.length < 3) return null;
  const sorted = inWindow.slice().sort((a, b) => a.sent_date.localeCompare(b.sent_date));
  const latest = sorted[sorted.length - 1];
  if (latest.delivered < cfg.min_delivered_on_record) return null;
  if (latest.ctor == null) return null;

  const priors = sorted.slice(0, -1).filter((p) => p.ctor != null);
  if (priors.length < 2) return null;
  const priorBest = Math.max(...priors.map((p) => p.ctor as number));
  if (latest.ctor <= priorBest + cfg.min_beat_pp) return null;

  const liftPp = latest.ctor - priorBest;
  const confidence: WinConfidence =
    liftPp > 0.03 && latest.delivered >= 2000
      ? "high"
      : liftPp > 0.015
        ? "medium"
        : "low";

  return {
    win_type: "verified_ctor_record",
    category: "momentum",
    headline: `Best-ever click-to-open: ${pctString(latest.ctor)} on their most recent send`,
    metric_value: latest.ctor,
    comparison_value: priorBest,
    comparison_basis: "self",
    confidence,
    mapped_opportunity:
      "Reinforce whatever made this send land — subject line, top link, layout — and consider running dynamic content on the next top-of-funnel push.",
    publication_id: pub.publication_id,
    publication_name: pub.publication_name,
  };
}

// ─── Rule 2: verified_open_streak ─────────────────────────────────
// Fires when the most recent N complete weeks all posted an open
// rate at least `min_lift_pp` above the trailing baseline (mean of
// the prior `baseline_weeks` weeks). Guards against low-volume
// weeks that could easily beat a noisy baseline.
export function ruleVerifiedOpenStreak(
  pub: PublicationMetrics,
  now: Date = new Date(),
  config: WinsConfig = DEFAULT_WINS_CONFIG
): RuleHit | null {
  const cfg = config.verified_open_streak;
  const closed = completedWeeks(pub.weeklyBuckets, now);
  if (closed.length < cfg.min_streak_weeks + cfg.baseline_weeks) return null;

  const streakWindow = closed.slice(-cfg.min_streak_weeks);
  const baselineWindow = closed.slice(
    -(cfg.min_streak_weeks + cfg.baseline_weeks),
    -cfg.min_streak_weeks
  );
  if (baselineWindow.length < cfg.baseline_weeks) return null;

  const baselineWeightedOpens = baselineWindow.reduce(
    (s, w) => s + w.opens,
    0
  );
  const baselineWeightedDelivered = baselineWindow.reduce(
    (s, w) => s + w.delivered,
    0
  );
  if (baselineWeightedDelivered < 1000) return null;
  const baseline = baselineWeightedOpens / baselineWeightedDelivered;

  for (const w of streakWindow) {
    if (w.sends < cfg.min_sends_per_week) return null;
    if (w.open_rate < baseline + cfg.min_lift_pp) return null;
  }

  const streakMean =
    streakWindow.reduce((s, w) => s + w.open_rate, 0) / streakWindow.length;
  const liftPp = streakMean - baseline;

  const confidence: WinConfidence =
    liftPp > 0.05 ? "high" : liftPp > 0.03 ? "medium" : "low";

  return {
    win_type: "verified_open_streak",
    category: "consistency",
    headline: `${cfg.min_streak_weeks} straight weeks above their trailing open-rate baseline (${pctString(streakMean)} vs ${pctString(baseline)})`,
    metric_value: streakMean,
    comparison_value: baseline,
    comparison_basis: "self",
    confidence,
    mapped_opportunity:
      "Their audience is warmer than their own norm right now — a good moment to reinforce cadence, tee up a content series, or reintroduce a paid tier / upgrade CTA.",
    publication_id: pub.publication_id,
    publication_name: pub.publication_name,
  };
}

// ─── Rule 3: quality_growth ───────────────────────────────────────
// Fires when engaged audience (delivered × open_rate) grew week
// over week for `min_weeks` consecutive weeks WITHOUT the open rate
// collapsing. Phase 1 stand-in for "list grew AND active-rate
// held/rose" — the doc's version needs historical subscriber
// counts we don't have plumbed in yet, and engaged audience is a
// tighter signal than raw sends anyway.
export function ruleQualityGrowth(
  pub: PublicationMetrics,
  now: Date = new Date(),
  config: WinsConfig = DEFAULT_WINS_CONFIG
): RuleHit | null {
  const cfg = config.quality_growth;
  const closed = completedWeeks(pub.weeklyBuckets, now);
  if (closed.length < cfg.min_weeks) return null;

  const window = closed.slice(-cfg.min_weeks);
  const engaged = window.map((w) => w.delivered * w.open_rate);

  // Strictly increasing.
  for (let i = 1; i < engaged.length; i++) {
    if (engaged[i] <= engaged[i - 1]) return null;
  }

  const firstOpenRate = window[0].open_rate;
  if (firstOpenRate <= 0) return null;
  for (const w of window) {
    if (w.open_rate < firstOpenRate * cfg.min_open_rate_retention) return null;
  }

  const endEngaged = engaged[engaged.length - 1];
  if (endEngaged < cfg.min_engaged_end) return null;

  const startEngaged = engaged[0];
  const growthMultiple = endEngaged / Math.max(startEngaged, 1);

  const confidence: WinConfidence =
    growthMultiple > 1.5 ? "high" : growthMultiple > 1.2 ? "medium" : "low";

  return {
    win_type: "quality_growth",
    category: "list-health",
    headline: `Engaged audience grew ${((growthMultiple - 1) * 100).toFixed(0)}% over ${cfg.min_weeks} weeks — open rate held above baseline`,
    metric_value: endEngaged,
    comparison_value: startEngaged,
    comparison_basis: "self",
    confidence,
    mapped_opportunity:
      "Growth stuck without engagement erosion is the right shape to layer monetization on — worth talking about Boosts, referral, or Ad Network placement while the base is warm.",
    publication_id: pub.publication_id,
    publication_name: pub.publication_name,
  };
}

// ─── Rule 4: deliverability_streak ────────────────────────────────
// Fires when the most recent N complete weeks all posted a delivery
// rate above `min_delivery_rate` with hard-bounces staying below
// `max_hard_bounce_rate` AND open rate at/above `min_open_rate`.
// The open-rate guard was added Phase 1 v2 after a sanity check on
// Jacob's book showed 89% of publications matched without it —
// turning the win into background noise.
export function ruleDeliverabilityStreak(
  pub: PublicationMetrics,
  now: Date = new Date(),
  config: WinsConfig = DEFAULT_WINS_CONFIG
): RuleHit | null {
  const cfg = config.deliverability_streak;
  const closed = completedWeeks(pub.weeklyBuckets, now);
  if (closed.length < cfg.min_streak_weeks) return null;
  const window = closed.slice(-cfg.min_streak_weeks);

  for (const w of window) {
    if (w.sends < cfg.min_sends_per_week) return null;
    if (w.delivery_rate < cfg.min_delivery_rate) return null;
    const hardBounceRate = w.sends > 0 ? w.hard_bounces / w.sends : 0;
    if (hardBounceRate > cfg.max_hard_bounce_rate) return null;
    if (w.open_rate < cfg.min_open_rate) return null;
  }

  const avgDelivery =
    window.reduce((s, w) => s + w.delivery_rate, 0) / window.length;
  const avgOpen =
    window.reduce((s, w) => s + w.open_rate, 0) / window.length;

  return {
    win_type: "deliverability_streak",
    category: "consistency",
    headline: `${cfg.min_streak_weeks} straight weeks of clean deliverability (avg ${pctString(avgDelivery, 2)}, ${pctString(avgOpen)} opens) — no bounce spike`,
    metric_value: avgDelivery,
    comparison_value: cfg.min_delivery_rate,
    comparison_basis: "self",
    confidence: avgDelivery > 0.995 ? "high" : "medium",
    mapped_opportunity:
      "Inbox is warm — a good window to nudge them on send frequency, or to launch a re-engagement flow they've been holding back on for deliverability reasons.",
    publication_id: pub.publication_id,
    publication_name: pub.publication_name,
  };
}

/** Ordered list of rules the engine iterates over. Add new rules
 *  here — the engine treats null returns as "no hit" and moves on.
 *  Rules accept an optional third `config` param for KV-override
 *  support; when omitted they use DEFAULT_WINS_CONFIG. */
export const RULES: Array<
  (pub: PublicationMetrics, now?: Date, config?: WinsConfig) => RuleHit | null
> = [
  ruleVerifiedCtorRecord,
  ruleVerifiedOpenStreak,
  ruleQualityGrowth,
  ruleDeliverabilityStreak,
];
