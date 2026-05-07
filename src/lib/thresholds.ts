import type { PostMetricsRow, RedFlag } from "./types";

/**
 * Deliverability thresholds
 *
 * Values encode the operational definition of a "red flag" used by the CSM
 * Enterprise Deliverability Alert workflow. Thresholds apply to a single
 * post's sent-day metrics. Sources:
 *   - Google Postmaster / Microsoft SNDS guidance
 *   - Internal historical review of Enterprise incident triggers
 *
 * When adjusting these, update the workflow doc in the CSM plugin
 * (enterprise-deliverability-alert/references/deliverability-thresholds.md)
 * in lockstep — that's what CSMs reference in customer conversations.
 */
export const THRESHOLDS = {
  delivery_rate: { critical: 0.95, warning: 0.97 },
  open_rate: { critical: 0.15, warning: 0.2 },
  hard_bounce_rate: { critical: 0.02, warning: 0.01 },
  soft_bounce_rate: { critical: 0.05, warning: 0.03 },
  unsub_rate: { critical: 0.005, warning: 0.002 },
  spam_rate: { critical: 0.003, warning: 0.001 },
} as const;

export const MIN_SENDS_FOR_FLAG = 500;

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * Analyze a post's metrics and return all triggered red flags.
 * Empty array = healthy send.
 */
export function analyzePost(row: PostMetricsRow): RedFlag[] {
  const flags: RedFlag[] = [];
  if (row.sent < MIN_SENDS_FOR_FLAG) return flags;

  // Delivery rate — lower is worse
  if (row.delivery_rate < THRESHOLDS.delivery_rate.critical) {
    flags.push({
      code: "DELIVERY_CRITICAL",
      severity: "critical",
      metric: "delivery_rate",
      value: row.delivery_rate,
      threshold: THRESHOLDS.delivery_rate.critical,
      message: `Delivery rate ${pct(row.delivery_rate)} below ${pct(
        THRESHOLDS.delivery_rate.critical
      )} critical threshold`,
    });
  } else if (row.delivery_rate < THRESHOLDS.delivery_rate.warning) {
    flags.push({
      code: "DELIVERY_WARN",
      severity: "warning",
      metric: "delivery_rate",
      value: row.delivery_rate,
      threshold: THRESHOLDS.delivery_rate.warning,
      message: `Delivery rate ${pct(row.delivery_rate)} below ${pct(
        THRESHOLDS.delivery_rate.warning
      )} warning threshold`,
    });
  }

  // Open rate — lower is worse (proxy for inbox placement)
  if (row.open_rate < THRESHOLDS.open_rate.critical) {
    flags.push({
      code: "OPEN_CRITICAL",
      severity: "critical",
      metric: "open_rate",
      value: row.open_rate,
      threshold: THRESHOLDS.open_rate.critical,
      message: `Open rate ${pct(row.open_rate)} below ${pct(
        THRESHOLDS.open_rate.critical
      )} — possible inbox placement problem`,
    });
  } else if (row.open_rate < THRESHOLDS.open_rate.warning) {
    flags.push({
      code: "OPEN_WARN",
      severity: "warning",
      metric: "open_rate",
      value: row.open_rate,
      threshold: THRESHOLDS.open_rate.warning,
      message: `Open rate ${pct(row.open_rate)} below ${pct(
        THRESHOLDS.open_rate.warning
      )} warning threshold`,
    });
  }

  // Hard bounce — higher is worse
  if (row.hard_bounce_rate > THRESHOLDS.hard_bounce_rate.critical) {
    flags.push({
      code: "HARD_BOUNCE_CRITICAL",
      severity: "critical",
      metric: "hard_bounce_rate",
      value: row.hard_bounce_rate,
      threshold: THRESHOLDS.hard_bounce_rate.critical,
      message: `Hard bounce rate ${pct(
        row.hard_bounce_rate
      )} exceeds ${pct(
        THRESHOLDS.hard_bounce_rate.critical
      )} — list hygiene problem`,
    });
  } else if (row.hard_bounce_rate > THRESHOLDS.hard_bounce_rate.warning) {
    flags.push({
      code: "HARD_BOUNCE_WARN",
      severity: "warning",
      metric: "hard_bounce_rate",
      value: row.hard_bounce_rate,
      threshold: THRESHOLDS.hard_bounce_rate.warning,
      message: `Hard bounce rate ${pct(
        row.hard_bounce_rate
      )} above ${pct(THRESHOLDS.hard_bounce_rate.warning)} warning threshold`,
    });
  }

  // Soft bounce
  if (row.soft_bounce_rate > THRESHOLDS.soft_bounce_rate.critical) {
    flags.push({
      code: "SOFT_BOUNCE_CRITICAL",
      severity: "critical",
      metric: "soft_bounce_rate",
      value: row.soft_bounce_rate,
      threshold: THRESHOLDS.soft_bounce_rate.critical,
      message: `Soft bounce rate ${pct(row.soft_bounce_rate)} exceeds ${pct(
        THRESHOLDS.soft_bounce_rate.critical
      )}`,
    });
  }

  // Unsub rate
  if (row.unsub_rate > THRESHOLDS.unsub_rate.critical) {
    flags.push({
      code: "UNSUB_CRITICAL",
      severity: "critical",
      metric: "unsub_rate",
      value: row.unsub_rate,
      threshold: THRESHOLDS.unsub_rate.critical,
      message: `Unsub rate ${pct(row.unsub_rate)} exceeds ${pct(
        THRESHOLDS.unsub_rate.critical
      )} — audience fatigue`,
    });
  }

  // Spam / FBL reports — most serious flag
  if (row.spam_rate > THRESHOLDS.spam_rate.critical) {
    flags.push({
      code: "SPAM_CRITICAL",
      severity: "critical",
      metric: "spam_rate",
      value: row.spam_rate,
      threshold: THRESHOLDS.spam_rate.critical,
      message: `Spam complaint rate ${pct(row.spam_rate)} exceeds ${pct(
        THRESHOLDS.spam_rate.critical
      )} — immediate intervention needed`,
    });
  } else if (row.spam_rate > THRESHOLDS.spam_rate.warning) {
    flags.push({
      code: "SPAM_WARN",
      severity: "warning",
      metric: "spam_rate",
      value: row.spam_rate,
      threshold: THRESHOLDS.spam_rate.warning,
      message: `Spam complaint rate ${pct(row.spam_rate)} above ${pct(
        THRESHOLDS.spam_rate.warning
      )} warning threshold`,
    });
  }

  return flags;
}
