/**
 * D&C Upgrade Analysis — orchestrator.
 *
 * Runs pillars 1–4, 6, and 8 in parallel via runNativeQuery calls,
 * feeds the counters into rules.ts for per-pillar scoring, computes
 * escalation + overall verdict, and returns the assembled
 * UpgradeAnalysisReport.
 *
 * The engine is deliberately deterministic and side-effect-free — no
 * KV writes here. Callers (the /api/upgrade-analysis/scan route)
 * decide whether to persist. This makes it trivial to run headless
 * from a script or a test.
 *
 * Slack search integration is a v2 concern; the report's
 * `slack_signals` array is always empty in v1. The escalation rule
 * that reads it still runs, so once slack-search.ts lands the
 * report shape doesn't have to change.
 */

import { loadUpgradeAnalysisConfig } from "../data/upgrade-analysis-config";
import type { UpgradeAnalysisConfig } from "../data/upgrade-analysis-config-types";
import {
  acquisitionHasSuspiciousLabels,
  runAcquisitionPillar,
  runFunnelPillar,
  runIdentityPillar,
  runNetworkPillar,
  runProviderPillar,
} from "./upgrade-analysis/pillars";
import {
  computeDeliverabilitySnapshot,
  computeEscalation,
  computeOverall,
  engagementTruth,
  scoreAcquisition,
  scoreFunnel,
  scoreIdentity,
  scoreNetwork,
  scoreProviderComplaints,
  worstOf,
} from "./upgrade-analysis/rules";
import type {
  PillarKey,
  PillarScore,
  SlackSearchHit,
  UpgradeAnalysisReport,
} from "./upgrade-analysis/types";

export interface RunUpgradeAnalysisInput {
  publicationId: string;
  /** Org id is required for Pillars 2 (api keys) + 8 (org flags).
   *  Callers can pass it directly (from Customer.workspace_id which
   *  is really the pub id, joined against org via Metabase lookup)
   *  or leave it unset — the engine will resolve it via Pillar 1 as
   *  a fallback. Passing it up-front avoids a second Postgres hop. */
  organizationId?: string;
  /** Session email of whoever triggered the scan. Stamped on the
   *  report + used to attribute the action-log entry. */
  triggeredBy?: string | null;
  /** Optional Slack signals to fold into the escalation rules —
   *  populated by v2's slack-search.ts. Empty array in v1. */
  slackSignals?: SlackSearchHit[];
  /** Optional override of the loaded threshold config. Test-only. */
  config?: UpgradeAnalysisConfig;
}

export async function runUpgradeAnalysis(
  input: RunUpgradeAnalysisInput
): Promise<UpgradeAnalysisReport> {
  const cfg = input.config ?? (await loadUpgradeAnalysisConfig());

  // Pillar 1 first — it also gives us the org_id when caller didn't.
  const identity = await runIdentityPillar(input.publicationId);
  const orgId = input.organizationId ?? identity.org_id;

  // Fan out the rest in parallel. Each pillar times out independently
  // (see PILLAR_TIMEOUT_MS in pillars.ts) so one slow query doesn't
  // brick the scan.
  const [acquisition, funnel, provider, network] = await Promise.all([
    runAcquisitionPillar(input.publicationId, orgId, cfg),
    runFunnelPillar(input.publicationId, cfg),
    runProviderPillar(input.publicationId, cfg),
    orgId ? runNetworkPillar(orgId) : Promise.resolve(emptyNetwork()),
  ]);

  // ─── Score each pillar ─────────────────────────────────────────────

  const identityScore = scoreIdentity({
    deleted_at: identity.deleted_at,
    age_days: identity.age_days,
    uniq_subs_30d: funnel.uniq_subs,
  });

  const acqLabels = acquisitionHasSuspiciousLabels(acquisition);
  const acquisitionScore = scoreAcquisition({
    opt_in_coverage_pct: acquisition.opt_in_coverage_pct,
    suspicious_filename: acqLabels.file,
    suspicious_api_key: acqLabels.api_key,
  });

  const funnelScored = scoreFunnel(funnel, cfg);
  const engagementScored = engagementTruth(funnel, cfg);
  const providerScored = scoreProviderComplaints(provider, funnel, cfg);
  const networkScore = scoreNetwork(network);

  // Pillar 3 (funnel) and Pillar 6 (provider) both weigh into the
  // "funnel" pillar in the UI's mental model, but we track them
  // separately internally so the UI can annotate which lane the
  // signal came from. worstOf() folds them for the overall verdict.
  const pillar_scores: Record<PillarKey, PillarScore> = {
    identity: identityScore,
    acquisition: acquisitionScore,
    funnel: worstOf(funnelScored.score, providerScored.score),
    engagement: engagementScored.score,
    provider: providerScored.score,
    network: networkScore,
  };

  // ─── Escalation ────────────────────────────────────────────────────

  const escalation = computeEscalation({
    pillar_scores,
    slack_signals: input.slackSignals ?? [],
    network,
    blended_complaint_rate: providerScored.blended_complaint_rate,
    absolute_complaint_count: funnel.spam,
    cfg,
  });

  const overall = computeOverall(pillar_scores, escalation.needed);

  return {
    pub_id: input.publicationId,
    org_id: orgId,
    generated_at: new Date().toISOString(),
    triggered_by: input.triggeredBy ?? null,
    pillars: {
      identity,
      acquisition,
      funnel,
      // Engagement shares the funnel raw counters but we surface it
      // as its own pillar so the UI can render the verified-click
      // truth panel independently.
      engagement: funnel,
      provider,
      network,
    },
    slack_signals: input.slackSignals ?? [],
    deliverability_snapshot: computeDeliverabilitySnapshot(funnel),
    pillar_scores,
    escalation,
    overall,
    raw_counters: {
      identity_score: identityScore,
      acquisition_score: acquisitionScore,
      acquisition_labels: acqLabels,
      funnel_scored: funnelScored,
      engagement_scored: engagementScored,
      provider_scored: providerScored,
      network_score: networkScore,
      config_snapshot: cfg,
    },
  };
}

function emptyNetwork() {
  return {
    org_flags: [],
    aup_prohibited_use_active: false,
    ip_already_used_active: false,
    network_map_incomplete: true as const,
  };
}
