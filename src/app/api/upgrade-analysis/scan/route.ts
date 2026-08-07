import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { runUpgradeAnalysis } from "@/lib/engines/upgrade-analysis";
import { loadUpgradeAnalysisConfig } from "@/lib/data/upgrade-analysis-config";
import {
  isReportFresh,
  loadUpgradeAnalysis,
  saveUpgradeAnalysis,
} from "@/lib/data/upgrade-analysis-store";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/upgrade-analysis/scan
 *
 * On-demand scan endpoint. Session-authed only — no cron branch, per
 * the plan (the primary use case is proactive outreach for non-
 * Enterprise customers, and AMs kick off analyses one at a time).
 *
 * Body:
 *   { publicationId: string, organizationId?: string, force?: boolean }
 *
 * Freshness guard: if we've already scanned this pub within
 * `volume.freshness_hours` (default 24h) and `force` isn't true,
 * return the cached report with `cached: true`. Guards against a
 * double-click racking up ClickHouse cost.
 *
 * Side effects on a fresh scan:
 *   - Persist the report + last_scanned_at to KV.
 *   - Append an `upgrade_analysis` action-log entry so the
 *     customer's Notes timeline shows who ran it and when.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("upgrade-analysis", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { publicationId?: string; organizationId?: string; force?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const publicationId = (body.publicationId ?? "").trim();
  if (!publicationId) {
    return NextResponse.json(
      { error: "Missing publicationId" },
      { status: 400 }
    );
  }

  try {
    const cfg = await loadUpgradeAnalysisConfig();

    // Freshness guard.
    if (!body.force) {
      const existing = await loadUpgradeAnalysis(publicationId);
      if (existing && isReportFresh(existing, cfg.volume.freshness_hours)) {
        return NextResponse.json({
          ok: true,
          cached: true,
          report: existing.report,
          last_scanned_at: existing.last_scanned_at,
        });
      }
    }

    // Fresh scan.
    const report = await runUpgradeAnalysis({
      publicationId,
      organizationId: body.organizationId,
      triggeredBy: email,
      config: cfg,
    });
    const stored = await saveUpgradeAnalysis(report);

    // Action-log entry — the workspace_id we know is the pub_id
    // (q10600 keys customers by publication id). appendActionLog
    // never throws; a log write failure won't fail the scan.
    await appendActionLog([
      {
        workspace_id: publicationId,
        text: `Ran D&C Upgrade Analysis (verdict: ${report.overall}${
          report.escalation.needed ? " — escalation needed" : ""
        })`,
        created_by: email,
        action_kind: "upgrade_analysis",
        metadata: {
          overall: report.overall,
          escalation_needed: report.escalation.needed,
          escalation_reasons: report.escalation.reasons.map((r) => r.code),
          pillar_scores: report.pillar_scores,
        },
      },
    ]);

    return NextResponse.json({
      ok: true,
      cached: false,
      report,
      last_scanned_at: stored.last_scanned_at,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[upgrade-analysis/scan] 500", {
      publicationId,
      message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
