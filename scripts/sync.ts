#!/usr/bin/env tsx
/**
 * Pull the book of business from Metabase (q10600) and write a snapshot to
 * data/snapshot.json. The dashboard reads this snapshot when DATA_SOURCE=snapshot,
 * so page loads stay sub-second even when Metabase q10600 is slow (~30–60s cold).
 *
 * Usage:
 *   npm run sync               # refresh snapshot (loads .env.local automatically)
 *
 * Schedule it however you like:
 *   • System cron:    0 *\/2 * * *  cd /path/to/CSMDash && npm run sync
 *   • GitHub Actions: see .github/workflows/sync.yml
 *   • Run on demand:  npm run sync
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { runSavedQuestion } from "../src/lib/metabase";

const QUESTION_ID = 10600;
const OUT_PATH =
  process.env.SNAPSHOT_PATH ?? path.join(process.cwd(), "data/snapshot.json");

async function main() {
  if (!process.env.METABASE_URL) {
    throw new Error(
      "METABASE_URL not set — make sure you ran via `npm run sync` (which loads .env.local) or exported the vars manually."
    );
  }

  const started = Date.now();
  console.error(`[sync] pulling q${QUESTION_ID} from Metabase…`);

  const rows = await runSavedQuestion(QUESTION_ID);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`[sync] fetched ${rows.length} rows in ${elapsed}s`);

  await mkdir(path.dirname(OUT_PATH), { recursive: true });

  const payload = {
    generated_at: new Date().toISOString(),
    question_id: QUESTION_ID,
    row_count: rows.length,
    rows,
  };
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.error(`[sync] wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[sync] failed:", err.message ?? err);
  process.exit(1);
});
