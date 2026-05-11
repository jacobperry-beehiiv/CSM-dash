#!/usr/bin/env tsx
/**
 * Pull the book of business from Metabase (q10600), encrypt with
 * AES-256-GCM, and write to data/snapshot.enc.json. The dashboard reads
 * + decrypts this file at request time.
 *
 * Usage:
 *   npm run sync               # encrypted refresh (loads .env.local automatically)
 *   SYNC_PLAINTEXT=1 npm run sync   # write data/snapshot.json (gitignored,
 *                                    useful for local debugging only)
 *
 * Schedule:
 *   • GitHub Actions: .github/workflows/sync-data.yml runs daily + on demand
 *   • Run locally:    npm run sync
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { runSavedQuestion } from "../src/lib/metabase";
import { encryptSnapshot } from "../src/lib/data/snapshot-crypto";

const QUESTION_ID = 10600;
const PLAINTEXT_PATH = path.join(process.cwd(), "data/snapshot.json");
const ENCRYPTED_PATH = path.join(process.cwd(), "data/snapshot.enc.json");

async function main() {
  if (!process.env.METABASE_URL) {
    throw new Error(
      "METABASE_URL not set — run via `npm run sync` (which loads .env.local) or export the vars manually."
    );
  }

  const usePlaintext = process.env.SYNC_PLAINTEXT === "1";
  if (!usePlaintext && !process.env.SNAPSHOT_ENCRYPTION_KEY) {
    throw new Error(
      "SNAPSHOT_ENCRYPTION_KEY not set. Generate one with `openssl rand -base64 32` and add it to .env.local + GitHub Actions secrets."
    );
  }

  const started = Date.now();
  console.error(`[sync] pulling q${QUESTION_ID} from Metabase…`);

  const rows = await runSavedQuestion(QUESTION_ID);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`[sync] fetched ${rows.length} rows in ${elapsed}s`);

  const payload = {
    generated_at: new Date().toISOString(),
    question_id: QUESTION_ID,
    row_count: rows.length,
    rows,
  };
  const json = JSON.stringify(payload);

  const outPath = usePlaintext ? PLAINTEXT_PATH : ENCRYPTED_PATH;
  await mkdir(path.dirname(outPath), { recursive: true });

  if (usePlaintext) {
    await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  } else {
    const envelope = encryptSnapshot(json);
    await writeFile(outPath, JSON.stringify(envelope, null, 2), "utf8");
  }
  console.error(`[sync] wrote ${outPath}`);
}

main().catch((err) => {
  console.error("[sync] failed:", err.message ?? err);
  process.exit(1);
});
