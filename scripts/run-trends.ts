import { runEngagementTrends } from "../src/lib/engines/engagement-trends";
import { TREND_METRIC_LABELS } from "../src/lib/engines/engagement-trends-types";

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

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;

  console.log(
    `\nExamined ${report.publications_examined} publications — ${report.workspaces.length} workspaces declining`
  );
  console.log(
    `Recent ${report.recent_days}d vs baseline ${report.baseline_days}d · ${report.generated_at}\n`
  );

  for (const ws of report.workspaces.slice(0, 25)) {
    const flag = ws.multi_publication ? " [MULTI-PUB]" : "";
    console.log(`${String(ws.severity).padStart(3)}  ${ws.workspace_name ?? ws.workspace_id}${flag}`);
    console.log(`     ${ws.summary}`);
    for (const p of ws.publications) {
      const vol =
        p.volume_ratio < 0.7 || p.volume_ratio > 1.4
          ? `  [volume x${p.volume_ratio}]`
          : "";
      console.log(`     - ${p.publication_name ?? p.publication_id}${vol}`);
      for (const m of p.metrics) {
        const runway =
          m.weeks_to_threshold != null ? `, ~${m.weeks_to_threshold}w to threshold` : "";
        console.log(
          `         ${TREND_METRIC_LABELS[m.metric]}: ${pct(m.baseline)} -> ${pct(
            m.recent
          )} (${pts(m.delta)}, cohort ${pts(m.cohort_delta)}, z=${m.robust_z.toFixed(
            1
          )}${runway})`
        );
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
