import { runEngagementTrends } from "../src/lib/engines/engagement-trends";
import {
  TREND_METRIC_DECIMALS,
  TREND_METRIC_LABELS,
  type TrendMetric,
} from "../src/lib/engines/engagement-trends-types";

/**
 * Headless engagement-trend run.
 *
 *   npm run run:trends              # human-readable top 25
 *   npm run run:trends -- --json    # full report on stdout
 *
 * Same shape as run-at-risk.ts: the engine returns a plain report, so
 * the CLI, the sync job and the API route all share one code path.
 */
async function main() {
  const asJson = process.argv.includes("--json");
  const report = await runEngagementTrends();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Metric-aware precision: a spam rate at one decimal is all zeroes.
  const dp = (m: TrendMetric) => TREND_METRIC_DECIMALS[m] ?? 1;
  const pct = (x: number, m: TrendMetric) => `${(x * 100).toFixed(dp(m))}%`;
  const pts = (x: number, m: TrendMetric) =>
    `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp(m))}pt`;

  console.log(
    `\nExamined ${report.publications_examined} publications — ${report.workspaces.length} workspaces declining`
  );
  // The measured dates, not the nominal day counts. On a weekly sweep
  // the difference between "last 28 days" and the window that
  // actually closed is the difference between a CSM quoting a number
  // that is current and one that is eight days stale.
  console.log(
    `Baseline ${report.baseline_window.start} to ${report.baseline_window.end} (${report.baseline_window.days}d)` +
      ` vs recent ${report.recent_window.start} to ${report.recent_window.end} (${report.recent_window.days}d)`
  );
  console.log(`Data through ${report.data_through} · run at ${report.generated_at}\n`);

  for (const ws of report.workspaces.slice(0, 25)) {
    const flag = ws.multi_publication ? " [MULTI-PUB]" : "";
    console.log(`${String(ws.severity).padStart(3)}  ${ws.workspace_name ?? ws.workspace_id}${flag}`);
    console.log(`     ${ws.summary}`);
    for (const p of ws.publications) {
      const vol =
        p.volume_ratio < 0.7 || p.volume_ratio > 1.4
          ? `  [volume x${p.volume_ratio}]`
          : "";
      const mix = p.mix_confounded ? "  [LIST MIX]" : "";
      const lists = p.lists.length > 1 ? `  (${p.lists.length} lists)` : "";
      console.log(
        `     - ${p.publication_name ?? p.publication_id}${vol}${mix}${lists}`
      );
      for (const m of p.metrics) {
        const runway =
          m.weeks_to_threshold != null ? `, ~${m.weeks_to_threshold}w to threshold` : "";
        console.log(
          `         ${TREND_METRIC_LABELS[m.metric]}: ${pct(
            m.baseline,
            m.metric
          )} -> ${pct(m.recent, m.metric)} (${pts(m.delta, m.metric)}, cohort ${pts(
            m.cohort_delta,
            m.metric
          )}, z=${m.robust_z.toFixed(1)}${runway})`
        );
        if (m.high && m.low) {
          console.log(
            `             high ${pct(m.high.value, m.metric)} wk of ${m.high.week_start}` +
              ` · low ${pct(m.low.value, m.metric)} wk of ${m.low.week_start}`
          );
        }
        if (m.mix_adjusted_delta != null && m.mix_delta != null) {
          console.log(
            `             within-list ${pts(m.mix_adjusted_delta, m.metric)}` +
              ` · mix ${pts(m.mix_delta, m.metric)}`
          );
        }
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
