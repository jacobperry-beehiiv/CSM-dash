/**
 * D&C Upgrade Analysis — guardrail-derived scoring rules.
 *
 * Every rule below implements one line from
 *   scratchpad/upgrade-analysis/references/interpretation-guardrails.md
 *
 * The pattern is: (raw counters, threshold config) → { score, notes }.
 * The scoring is intentionally deterministic — no LLM synthesis in v1
 * — so a D&C decision to override a verdict is auditable ("we knew
 * the rule said amber; we cleared it because …").
 *
 * The guardrails encoded here:
 * - Kumo `0.0.0.0` deferrals are stripped before computing the
 *   real-rejection rate. A headline "20% deferred" is often mostly
 *   Kumo queue delay, not provider rejections.
 * - Trust `is_verified_clicked`, not raw opens. Apple MPP and other
 *   machine opens inflate raw open rate to 40–70% on lists that have
 *   ~zero real engagement.
 * - Complaint numbers are always rates, never absolute counts.
 *   "466 complaints" on 3.5M sends is a healthy rate; on 100k sends
 *   it's critical.
 * - Comcast is complaint-led and has its own red line (~0.09%). A
 *   Comcast spike is a per-pub attributable signal even when
 *   blended looks fine.
 * - Shared-pool RBL listings are pool-aggregate, not per-pub — do
 *   NOT let those trigger a pillar. (We simply don't run pool-based
 *   RBL scoring in v1; Pillar 5 domain recon is deferred.)
 */

import type {
  EscalationReason,
  FunnelCounters,
  NetworkCounters,
  PillarScore,
  ProviderCounters,
  SlackSearchHit,
} from "./types";
import type { UpgradeAnalysisConfig } from "../../data/upgrade-analysis-config-types";

// ─── Helpers ─────────────────────────────────────────────────────────────

/** `worst-of` two scores. Convenience for composing multi-condition
 *  scores within a single pillar. Uses the natural order red > amber > green. */
export function worstOf(a: PillarScore, b: PillarScore): PillarScore {
  const rank = { green: 0, amber: 1, red: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/** Safe division — returns 0 on divide-by-zero (used everywhere we
 *  convert counts to rates; every count denominator here is
 *  legitimately zero when a pub sent nothing in the window). */
export function rate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}

// ─── Pillar 3: funnel (deferral + hard-bounce) ───────────────────────────

/** Compute the real-rejection rate — Kumo `0.0.0.0` queue-delay
 *  deferrals are excluded via the SQL (they're filtered in
 *  pillars.ts's Pillar-6 reason-classification query, and Pillar-3's
 *  aggregate `deferred` count is used as-is with a warning surfaced
 *  in the UI via `kumo_share_of_deferrals` from Pillar 6). This
 *  function scores the funnel using the deferred count as the
 *  numerator; when Pillar 6 reports high Kumo share, the UI shows a
 *  banner explaining the deferral rate is inflated by queue delay. */
export function scoreFunnel(
  funnel: FunnelCounters,
  cfg: UpgradeAnalysisConfig
): { score: PillarScore; deferral_rate: number; hard_bounce_rate: number } {
  const deferral_rate = rate(funnel.deferred, funnel.deliv);
  const hard_bounce_rate = rate(funnel.hard_b, funnel.deliv);

  let score: PillarScore = "green";
  if (deferral_rate >= cfg.deferrals.critical) score = worstOf(score, "red");
  else if (deferral_rate >= cfg.deferrals.watch) score = worstOf(score, "amber");
  if (hard_bounce_rate >= cfg.deferrals.hard_bounce_red)
    score = worstOf(score, "red");

  return { score, deferral_rate, hard_bounce_rate };
}

// ─── Pillar 4: engagement (verified clicks, not opens) ───────────────────

/** Minimum deliveries required before we score the engagement pillar
 *  at all. A pub with <1000 deliveries in the window doesn't have
 *  enough signal to tell "hollow" from "quiet". Below this we return
 *  green with `insufficient_volume: true` so the UI can render the
 *  cause instead of a false red. */
const MIN_DELIV_FOR_ENGAGEMENT = 1000;

/** Trust verified clicks, not opens. `hollow_list = true` when the
 *  verified click rate is below the config floor — the audience
 *  looks engaged (high raw open rate) but isn't (near-zero verified
 *  clicks = the opens are MPP/machine).
 *
 *  Guarded on minimum volume: below MIN_DELIV_FOR_ENGAGEMENT the
 *  pillar is skipped (green + insufficient_volume). Otherwise
 *  `0 / 0 = 0 < 0.005` would false-red every pub that hasn't sent. */
export function engagementTruth(
  funnel: FunnelCounters,
  cfg: UpgradeAnalysisConfig
): {
  score: PillarScore;
  verified_click_rate: number;
  verified_ctor: number;
  hollow_list: boolean;
  raw_open_rate: number;
  insufficient_volume: boolean;
} {
  const verified_click_rate = rate(funnel.v_clicks, funnel.deliv);
  const verified_ctor = rate(funnel.v_clicks, funnel.v_opens);
  const raw_open_rate = rate(funnel.opens, funnel.deliv);

  if (funnel.deliv < MIN_DELIV_FOR_ENGAGEMENT) {
    return {
      score: "green",
      verified_click_rate,
      verified_ctor,
      hollow_list: false,
      raw_open_rate,
      insufficient_volume: true,
    };
  }

  const hollow_list =
    verified_click_rate < cfg.engagement.hollow_verified_click_rate;

  let score: PillarScore = "green";
  if (hollow_list) score = "red";
  else if (verified_ctor < cfg.engagement.ctor_healthy) score = "amber";

  return {
    score,
    verified_click_rate,
    verified_ctor,
    hollow_list,
    raw_open_rate,
    insufficient_volume: false,
  };
}

// ─── Pillar 6: provider concentration + complaint rate ───────────────────

/** Per-provider spam-complaint scoring. Comcast has its own red line
 *  because Comcast is complaint-led and has directly caused beehiiv-
 *  wide Comcast blocking before. Other providers escalate via the
 *  ratio-to-blended rule.
 *
 *  Returns the worst score across all providers PLUS the blended
 *  complaint rate (used again by the escalation rule for the
 *  composite-complaint enforcement threshold). */
export function scoreProviderComplaints(
  provider: ProviderCounters,
  funnelForBlended: FunnelCounters,
  cfg: UpgradeAnalysisConfig
): {
  score: PillarScore;
  blended_complaint_rate: number;
  provider_hits: Array<{
    dom: string;
    rate: number;
    ratio_to_blended: number;
    score: PillarScore;
    reason: string;
  }>;
} {
  const blended = rate(funnelForBlended.spam, funnelForBlended.deliv);

  let overall: PillarScore = "green";
  if (blended >= cfg.complaints.blended_critical) overall = worstOf(overall, "red");
  else if (blended >= cfg.complaints.blended_watch)
    overall = worstOf(overall, "amber");

  const hits: Array<{
    dom: string;
    rate: number;
    ratio_to_blended: number;
    score: PillarScore;
    reason: string;
  }> = [];

  for (const row of provider.providers) {
    const providerRate = row.deliv > 0 ? row.spam / row.deliv : 0;
    const ratio = blended > 0 ? providerRate / blended : 0;
    let score: PillarScore = "green";
    let reason = "";

    // Comcast red-line — pub-specific attributable signal.
    if (row.dom === "comcast.net" && providerRate >= cfg.complaints.comcast_red) {
      score = "red";
      reason = `Comcast complaint rate ${(providerRate * 100).toFixed(3)}% ≥ ${(cfg.complaints.comcast_red * 100).toFixed(3)}% red-line`;
    } else if (
      blended > 0 &&
      ratio >= cfg.complaints.provider_ratio_amber &&
      providerRate >= cfg.complaints.blended_watch
    ) {
      // Any other provider running well above blended.
      score = "amber";
      reason = `${row.dom} rate ${(providerRate * 100).toFixed(3)}% is ${ratio.toFixed(1)}× blended (${(blended * 100).toFixed(3)}%)`;
    }
    if (score !== "green") {
      hits.push({ dom: row.dom, rate: providerRate, ratio_to_blended: ratio, score, reason });
      overall = worstOf(overall, score);
    }
  }

  return { score: overall, blended_complaint_rate: blended, provider_hits: hits };
}

// ─── Pillar 8: network read (org flags, active AUP) ──────────────────────

export function scoreNetwork(network: NetworkCounters): PillarScore {
  // Any active `aup_prohibited_use` on THIS org is red on its own —
  // the flag was applied for a reason. Historical (`deleted_at`)
  // flags are cleared and don't score.
  if (network.aup_prohibited_use_active) return "red";
  // `ip_already_used` alone is a raised eyebrow (multi-account
  // fingerprint). Amber; the Slack search hit is what usually
  // corroborates the "operator network" verdict.
  if (network.ip_already_used_active) return "amber";
  return "green";
}

// ─── Pillar 1: identity ──────────────────────────────────────────────────

/** Identity is scored soft. Deleted pubs are "red" (should never be
 *  upgrading); a young-and-large pub gets amber; everything else is
 *  green. The identity pillar isn't where verdicts get made — it's
 *  where the operator context gets surfaced. */
export function scoreIdentity(input: {
  deleted_at: string | null;
  age_days: number | null;
  uniq_subs_30d: number | null;
}): PillarScore {
  if (input.deleted_at) return "red";
  if (
    input.age_days !== null &&
    input.age_days < 60 &&
    (input.uniq_subs_30d ?? 0) > 50_000
  ) {
    return "amber";
  }
  return "green";
}

// ─── Pillar 2: acquisition (behaviour weighted, form of intake light) ────

/** Acquisition scoring is behaviour-first (per the guardrails):
 *  - Zero opt-in coverage across the base = amber (provenance gap,
 *    not proof of no consent).
 *  - Import filenames or API-key names matching the bought-broker
 *    token classifier = amber (they raise a flag, but the *behaviour*
 *    numbers — complaints, unsubs, hard bounces from Pillars 3+6 —
 *    are what push it to red).
 *  - We deliberately do NOT weight "import channel" itself as bad;
 *    imports can be legitimate ESP migration. */
export function scoreAcquisition(input: {
  opt_in_coverage_pct: number;
  suspicious_filename: boolean;
  suspicious_api_key: boolean;
}): PillarScore {
  if (input.opt_in_coverage_pct === 0) return "amber";
  if (input.suspicious_filename || input.suspicious_api_key) return "amber";
  return "green";
}

/** Token classifier for import filenames + API-key labels. Kept
 *  short + deterministic so admins can eyeball the list and add
 *  new bad tokens without a code change (future v2: move to KV). */
const BAD_ACQUISITION_TOKENS = [
  "bought",
  "purchase",
  "purchased",
  "broker",
  "list_purchase",
  "leadlist",
  "lead_list",
  "scraped",
  "harvest",
  "coreg",
  "co-reg",
];

export function looksSuspiciousLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return BAD_ACQUISITION_TOKENS.some((tok) => lower.includes(tok));
}

// ─── Escalation ──────────────────────────────────────────────────────────

/** Composite escalation verdict. Separate from the overall pillar
 *  worst-of because "all pillars green + Slack shows prior 'do not
 *  upgrade' decision" is exactly the gray case D&C owns. */
export function computeEscalation(input: {
  pillar_scores: Record<string, PillarScore>;
  slack_signals: SlackSearchHit[];
  network: NetworkCounters;
  blended_complaint_rate: number;
  absolute_complaint_count: number;
  cfg: UpgradeAnalysisConfig;
}): {
  needed: boolean;
  reasons: Array<{ code: EscalationReason; detail: string }>;
} {
  const reasons: Array<{ code: EscalationReason; detail: string }> = [];

  // Rule: any single pillar at the configured threshold.
  const scoreThreshold = input.cfg.escalation.escalate_on_pillar;
  const rank = { green: 0, amber: 1, red: 2 } as const;
  const min = rank[scoreThreshold];
  for (const [pillar, score] of Object.entries(input.pillar_scores)) {
    if (rank[score] >= min) {
      reasons.push({
        code: "pillar_red",
        detail: `Pillar "${pillar}" scored ${score}`,
      });
    }
  }

  // Rule: ≥ N amber pillars, even if none are red.
  const amberCount = Object.values(input.pillar_scores).filter(
    (s) => s === "amber"
  ).length;
  if (
    amberCount >= input.cfg.escalation.amber_pillars_to_escalate &&
    !reasons.some((r) => r.code === "pillar_red")
  ) {
    reasons.push({
      code: "multiple_amber",
      detail: `${amberCount} pillars are amber (threshold: ${input.cfg.escalation.amber_pillars_to_escalate})`,
    });
  }

  // Rule: active AUP flag on this org (or on a sibling).
  if (input.network.aup_prohibited_use_active) {
    reasons.push({
      code: "aup_prohibited_use",
      detail: "Active aup_prohibited_use flag on this organization",
    });
  }

  // Rule: Slack search hit on the escalation-term list.
  const badTerms = input.cfg.escalation.slack_escalation_terms.map((t) =>
    t.toLowerCase()
  );
  const matched = input.slack_signals.filter((hit) => {
    const snippet = hit.snippet.toLowerCase();
    return badTerms.some((term) => snippet.includes(term));
  });
  if (matched.length > 0) {
    reasons.push({
      code: "slack_prior_decision",
      detail: `Slack search matched: ${matched
        .map((m) => `"${m.matched_term}"`)
        .slice(0, 3)
        .join(", ")}${matched.length > 3 ? ` (+${matched.length - 3} more)` : ""}`,
    });
  }

  // Rule: composite complaint threshold — rate OR absolute floor.
  if (
    input.blended_complaint_rate >= input.cfg.complaints.enforcement_rate ||
    input.absolute_complaint_count >= input.cfg.complaints.enforcement_abs_floor
  ) {
    reasons.push({
      code: "composite_complaint_threshold",
      detail: `Blended complaint rate ${(input.blended_complaint_rate * 100).toFixed(3)}% (${input.absolute_complaint_count} complaints) meets or exceeds D&C enforcement floor`,
    });
  }

  return {
    needed: reasons.length > 0,
    reasons,
  };
}

/** Roll the per-pillar scores + escalation into the overall verdict.
 *  `hold` = at least one red or escalation-needed. `review_needed`
 *  = any amber or escalation. `clear` = all green and no escalation. */
export function computeOverall(
  pillar_scores: Record<string, PillarScore>,
  escalation_needed: boolean
): "clear" | "review_needed" | "hold" {
  const values = Object.values(pillar_scores);
  const hasRed = values.some((v) => v === "red");
  const hasAmber = values.some((v) => v === "amber");
  if (hasRed) return "hold";
  if (escalation_needed || hasAmber) return "review_needed";
  return "clear";
}
