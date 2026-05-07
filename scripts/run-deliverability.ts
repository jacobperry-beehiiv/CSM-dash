#!/usr/bin/env tsx
/**
 * CLI entrypoint for the deliverability engine.
 * Run: npm run run:deliverability -- [--all] [--date=YYYY-MM-DD]
 *
 * Prints a summary to stdout and JSON to stderr-friendly piping
 * so you can pipe it through `| jq '.alerts[].post.workspace_name'`.
 */

import { runDeliverabilityCheck } from "../src/lib/engines/deliverability";

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const dateArg = args.find((a) => a.startsWith("--date="));
  const targetDate = dateArg ? dateArg.slice("--date=".length) : undefined;

  const result = await runDeliverabilityCheck({
    csmName: all ? null : undefined,
    targetDate,
  });

  console.error(
    `[deliverability] ${result.csm_name ?? "all CSMs"} · ${result.target_date} · ${result.alerts.length} flagged / ${result.total_posts_yesterday} posts`
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
