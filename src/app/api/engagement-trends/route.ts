import { NextResponse } from "next/server";
import { readEngagementTrendsSnapshot } from "@/lib/data/engagement-trends-snapshot";
import { loadTrendClears, isTrendCleared } from "@/lib/data/trend-clears";
import type {
  ListSplit,
  TrendClear,
  TrendPoint,
  TrendWindow,
} from "@/lib/engines/engagement-trends-types";

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
export interface TrendApiWindows {
  recent_window: TrendWindow | null;
  baseline_window: TrendWindow | null;
  data_through: string | null;
}

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
    mix_confounded: boolean;
    lists: ListSplit[];
    metrics: Array<{
      metric: string;
      recent: number;
      baseline: number;
      delta: number;
      cohort_delta: number;
      weeks_to_threshold: number | null;
      severity: number;
      /** Highest and lowest week by value, with the dates. */
      high: TrendPoint | null;
      low: TrendPoint | null;
      mix_adjusted_delta: number | null;
      mix_delta: number | null;
    }>;
  }>;
}

/**
 * The full weekly series (`points`) is deliberately NOT forwarded.
 *
 * It stays in the snapshot, where the CLI and any future sparkline
 * can reach it, but the panel only ever quotes the peak and the
 * trough — and sending ~370 series of 13 points to every browser that
 * opens the table would be a few hundred KB nobody reads. Add it back
 * the day something actually plots it.
 */

export async function GET() {
  try {
    const snapshot = await readEngagementTrendsSnapshot();
    if (!snapshot) {
      return NextResponse.json({
        generated_at: null,
        recent_window: null,
        baseline_window: null,
        data_through: null,
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
          mix_confounded: p.mix_confounded ?? false,
          lists: p.lists ?? [],
          metrics: p.metrics.map((m) => ({
            metric: m.metric,
            recent: m.recent,
            baseline: m.baseline,
            delta: m.delta,
            cohort_delta: m.cohort_delta,
            weeks_to_threshold: m.weeks_to_threshold,
            severity: m.severity,
            high: m.high ?? null,
            low: m.low ?? null,
            mix_adjusted_delta: m.mix_adjusted_delta ?? null,
            mix_delta: m.mix_delta ?? null,
          })),
        })),
      };
      order.push(ws.workspace_id);
    }

    return NextResponse.json({
      generated_at: snapshot.generated_at,
      recent_days: snapshot.recent_days,
      baseline_days: snapshot.baseline_days,
      // Null on a snapshot written before these existed. The UI falls
      // back to the day counts rather than inventing dates, because a
      // wrong date is worse than no date here.
      recent_window: snapshot.recent_window ?? null,
      baseline_window: snapshot.baseline_window ?? null,
      data_through: snapshot.data_through ?? null,
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
