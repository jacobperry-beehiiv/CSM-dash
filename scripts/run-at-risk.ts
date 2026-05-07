#!/usr/bin/env tsx
import { runAtRiskCheck } from "../src/lib/engines/at-risk";

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");

  const result = await runAtRiskCheck({ csmName: all ? null : undefined });

  console.error(
    `[at-risk] ${result.csm_name ?? "all"} · ${result.accounts.length} flagged / ${result.total_in_book} in book`
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
