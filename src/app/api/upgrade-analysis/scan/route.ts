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
import type { AnalysisWindow } from "@/lib/engines/upgrade-analysis/types";
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
 *   {
 *     publicationId: string,
 *     organizationId?: string,
 *     force?: boolean,
 *     lookback_days?: number,       // preset presses
 *     start_date?: string,          // "YYYY-MM-DD" — custom range
 *     end_date?: string,            // "YYYY-MM-DD"
 *   }
 *
 * `lookback_days` and (`start_date`, `end_date`) are mutually
 * exclusive; both absent = the config default window per pillar.
 *
 * Freshness guard: if we've already scanned this pub in the SAME
 * window within `volume.freshness_hours` (default 24h) and `force`
 * isn't true, return the cached report with `cached: true`. Guards
 * against a double-click racking up ClickHouse cost while still
 * letting a "Last 7 days" re-scan bypass a fresh "Last 30 days"
 * cache entry — different windows write to different KV keys.
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

  let body: {
    publicationId?: string;
    organizationId?: string;
    force?: boolean;
    lookback_days?: number;
    start_date?: string;
    end_date?: string;
    ownerEmail?: string;
  } = {};
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

  // Parse + validate the analysis window. Two valid shapes:
  //   lookback → { lookback_days: 1..365 }
  //   range    → { start_date, end_date } both YMD, start ≤ end
  // Sending both is a client bug; refuse rather than silently choose.
  let window: AnalysisWindow | undefined;
  const hasLookback =
    body.lookback_days !== undefined && body.lookback_days !== null;
  const hasRange =
    (body.start_date !== undefined && body.start_date !== null) ||
    (body.end_date !== undefined && body.end_date !== null);
  if (hasLookback && hasRange) {
    return NextResponse.json(
      {
        error:
          "Pass either lookback_days OR (start_date, end_date), not both",
      },
      { status: 400 }
    );
  }
  if (hasLookback) {
    const days = Math.floor(Number(body.lookback_days));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return NextResponse.json(
        { error: "lookback_days must be an integer between 1 and 365" },
        { status: 400 }
      );
    }
    window = { kind: "lookback", lookback_days: days };
  } else if (hasRange) {
    const YMD = /^\d{4}-\d{2}-\d{2}$/;
    const start = String(body.start_date ?? "").trim();
    const end = String(body.end_date ?? "").trim();
    if (!YMD.test(start) || !YMD.test(end)) {
      return NextResponse.json(
        { error: "start_date and end_date must be YYYY-MM-DD" },
        { status: 400 }
      );
    }
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs < startMs
    ) {
      return NextResponse.json(
        { error: "start_date must be on or before end_date" },
        { status: 400 }
      );
    }
    // Cap the max span at ~1y so an accidental "since epoch" pick
    // doesn't melt ClickHouse.
    if (endMs - startMs > 366 * 86_400_000) {
      return NextResponse.json(
        { error: "Range must span at most 366 days" },
        { status: 400 }
      );
    }
    window = { kind: "range", start_date: start, end_date: end };
  }

  try {
    const cfg = await loadUpgradeAnalysisConfig();

    // Freshness guard — scoped to the picked window so different
    // ranges each cache independently. The KV lookup uses the same
    // (pub_id + window_suffix) key the eventual save will write.
    if (!body.force) {
      const existing = await loadUpgradeAnalysis(publicationId, window);
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
      window,
      // Owner email drives the Slack search's second query. Client
      // sends it in the POST body; safe to trust (session-authed
      // and only used to construct a Slack search string).
      ownerEmail: body.ownerEmail ?? null,
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
