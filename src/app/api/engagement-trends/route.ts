import { NextResponse } from "next/server";
import { readEngagementTrendsSnapshot } from "@/lib/data/engagement-trends-snapshot";
import { loadTrendClears, isTrendCleared } from "@/lib/data/trend-clears";
import type { TrendClear } from "@/lib/engines/engagement-trends-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/engagement-trends
 *
 * The pre-computed trend report with clear-state folded in. Reads the
 * snapshot only — never runs the engine. A live run is 39 ClickHouse
 * queries and minutes of wall time, which is why the engine isn't
 * imported here at all rather than guarded behind a flag someone could
 * flip on a bad day.
 *
 * Returns a map keyed by workspace_id so the customer table can look up
 * a row in O(1) while rendering, plus the ordered list for any surface
 * that wants a ranked queue.
 */
export interface TrendApiRow {
  workspace_id: string;
  workspace_name: string | null;
  severity: number;
  summary: string;
  multi_publication: boolean;
  /** Silenced by a clear that the current severity hasn't outgrown. */
  cleared: boolean;
  clear: TrendClear | null;
  publications: Array<{
    publication_id: string;
    publication_name: string | null;
    severity: number;
    volume_ratio: number;
    volume_confounded: boolean;
    metrics: Array<{
      metric: string;
      recent: number;
      baseline: number;
      delta: number;
      cohort_delta: number;
      weeks_to_threshold: number | null;
      severity: number;
    }>;
  }>;
}

export async function GET() {
  try {
    const snapshot = await readEngagementTrendsSnapshot();
    if (!snapshot) {
      return NextResponse.json({
        generated_at: null,
        publications_examined: 0,
        rows: {},
        order: [],
      });
    }

    const clears = await loadTrendClears();
    const rows: Record<string, TrendApiRow> = {};
    const order: string[] = [];

    for (const ws of snapshot.workspaces) {
      const clear = clears[ws.workspace_id];
      rows[ws.workspace_id] = {
        workspace_id: ws.workspace_id,
        workspace_name: ws.workspace_name,
        severity: ws.severity,
        summary: ws.summary,
        multi_publication: ws.multi_publication,
        cleared: isTrendCleared(clear, ws.severity),
        clear: clear ?? null,
        publications: ws.publications.map((p) => ({
          publication_id: p.publication_id,
          publication_name: p.publication_name,
          severity: p.severity,
          volume_ratio: p.volume_ratio,
          volume_confounded: p.volume_confounded,
          metrics: p.metrics.map((m) => ({
            metric: m.metric,
            recent: m.recent,
            baseline: m.baseline,
            delta: m.delta,
            cohort_delta: m.cohort_delta,
            weeks_to_threshold: m.weeks_to_threshold,
            severity: m.severity,
          })),
        })),
      };
      order.push(ws.workspace_id);
    }

    return NextResponse.json({
      generated_at: snapshot.generated_at,
      recent_days: snapshot.recent_days,
      baseline_days: snapshot.baseline_days,
      publications_examined: snapshot.publications_examined,
      rows,
      order,
    });
  } catch (e) {
    console.error("[engagement-trends] GET failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
