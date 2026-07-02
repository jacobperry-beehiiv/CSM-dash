import { loadCustomers } from "../data/load-customers";
import {
  accountRecentlySent,
  loadWinsBlob,
} from "../data/wins-store";
import {
  isoWeekLabel,
  winIdFor,
  type CandidateWin,
} from "../data/wins-types";
import { runAtRiskCheck } from "./at-risk";
import type { Customer } from "../types";
import { fetchWinsMetrics } from "./wins-metrics";
import { RULES } from "./wins-rules";

/**
 * Wins detection engine. Phase 1 — self-comparison rules only, no
 * ranking, no cooldown beyond the "sent in the last N days" gate.
 *
 * Pipeline:
 *   1. Load customers (has HubSpot overlay applied by loadCustomers).
 *   2. Run runAtRiskCheck to get the suppression set.
 *   3. Fetch 120-day metrics rollup for the book.
 *   4. Iterate rules per publication → RuleHit list.
 *   5. Wrap each hit as a CandidateWin, apply suppression + cadence.
 *   6. Return the full list — writer is the caller (endpoint uses
 *      upsertCandidates to persist).
 *
 * See src/lib/engines/at-risk.ts for the sibling structure.
 */

const CADENCE_GUARD_DAYS = 30;

export interface WinsDetectionOptions {
  customers?: Customer[];
  now?: Date;
  lookbackDays?: number;
  metricsSource?: "raw" | "verified";
}

export interface WinsDetectionResult {
  scanned_workspaces: number;
  scanned_publications: number;
  detected: number;
  suppressed_at_risk: number;
  suppressed_recent_send: number;
  candidates: CandidateWin[];
  generated_at: string;
  metrics_source: "raw" | "verified";
  lookback_days: number;
}

export async function runWinsDetection(
  opts: WinsDetectionOptions = {}
): Promise<WinsDetectionResult> {
  const now = opts.now ?? new Date();
  const customers = opts.customers ?? (await loadCustomers());

  // Suppression source: any account with active at-risk flags. We
  // pass the pre-loaded customer list so the at-risk engine doesn't
  // redundantly re-load the book.
  const atRiskSnapshot = await runAtRiskCheck({
    customers,
    csmName: null,
    now,
  });
  const atRiskWorkspaces = new Set<string>();
  for (const account of atRiskSnapshot.accounts) {
    if (account.customer.workspace_id && account.flags.length > 0) {
      atRiskWorkspaces.add(account.customer.workspace_id);
    }
  }

  // Cadence-guard source: prior sent wins within the last 30 days.
  const priorBlob = await loadWinsBlob();

  const metrics = await fetchWinsMetrics({
    customers,
    lookbackDays: opts.lookbackDays,
    metricsSource: opts.metricsSource,
  });

  const detectionWeek = isoWeekLabel(now);
  const detectedAt = now.toISOString();

  const customerByWorkspace = new Map<string, Customer>();
  for (const c of customers) {
    if (c.workspace_id) customerByWorkspace.set(c.workspace_id, c);
  }

  const candidates: CandidateWin[] = [];
  let scannedPublications = 0;
  let suppressedAtRisk = 0;
  let suppressedRecentSend = 0;

  for (const [workspaceId, pubs] of metrics.byWorkspace.entries()) {
    const customer = customerByWorkspace.get(workspaceId);
    if (!customer) continue;

    const workspaceAtRisk = atRiskWorkspaces.has(workspaceId);
    const workspaceRecentlySent = accountRecentlySent(
      priorBlob,
      workspaceId,
      CADENCE_GUARD_DAYS,
      now
    );

    for (const pub of pubs) {
      scannedPublications++;
      for (const rule of RULES) {
        const hit = rule(pub, now);
        if (!hit) continue;

        const winId = winIdFor(workspaceId, hit.win_type, detectionWeek);

        if (workspaceRecentlySent) {
          // Cadence guard — silently skip. Not surfaced as a
          // suppressed row because the same win_id will re-appear
          // next month once the cooldown elapses.
          suppressedRecentSend++;
          continue;
        }

        const candidate: CandidateWin = {
          win_id: winId,
          account_id: workspaceId,
          workspace_name: customer.workspace_name ?? pub.workspace_name,
          publication_id: hit.publication_id,
          publication_name: hit.publication_name,
          win_type: hit.win_type,
          category: hit.category,
          headline: hit.headline,
          metric_value: hit.metric_value,
          comparison_value: hit.comparison_value,
          comparison_basis: hit.comparison_basis,
          detected_at: detectedAt,
          detection_week: detectionWeek,
          confidence: hit.confidence,
          mapped_opportunity: hit.mapped_opportunity,
          status: "candidate",
          suppressed: workspaceAtRisk,
          suppression_reason: workspaceAtRisk
            ? "Held: account has active at-risk flag — never celebrate into a problem."
            : null,
          csm_name: customer.customer_success_manager ?? null,
        };

        if (workspaceAtRisk) suppressedAtRisk++;
        candidates.push(candidate);
      }
    }
  }

  return {
    scanned_workspaces: metrics.byWorkspace.size,
    scanned_publications: scannedPublications,
    detected: candidates.length,
    suppressed_at_risk: suppressedAtRisk,
    suppressed_recent_send: suppressedRecentSend,
    candidates,
    generated_at: detectedAt,
    metrics_source: metrics.metrics_source,
    lookback_days: metrics.lookback_days,
  };
}
