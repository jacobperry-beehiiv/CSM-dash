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
import { fetchLastActivity } from "../src/lib/integrations/hubspot";

const QUESTION_ID = 10600;
const PLAINTEXT_PATH = path.join(process.cwd(), "data/snapshot.json");
const ENCRYPTED_PATH = path.join(process.cwd(), "data/snapshot.enc.json");

/**
 * Column names q10600 might expose the HubSpot company ID under. We accept
 * any of them so the question can be edited without a sync deploy.
 */
const COMPANY_ID_KEYS = [
  "hubspot_company_id",
  "hs_object_id",
  "property_hs_object_id",
  "company_id_hubspot",
] as const;

function pickCompanyId(row: Record<string, unknown>): string | null {
  for (const k of COMPANY_ID_KEYS) {
    const v = row[k];
    if (v != null && v !== "") return String(v);
  }
  return null;
}

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

  // ─── HubSpot enrichment ─────────────────────────────────────────────
  // For every row that exposes a HubSpot company ID, look up the most-
  // recent activity across HubSpot's three rollup properties and stamp
  // it onto the row. Soft-fails: if HUBSPOT_ACCESS_TOKEN is unset or the
  // API errors, sync continues with the un-enriched rows.
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    const enrichStarted = Date.now();
    const idToRow = new Map<string, Record<string, unknown>>();
    for (const r of rows as Record<string, unknown>[]) {
      const id = pickCompanyId(r);
      if (id) idToRow.set(id, r);
    }
    const ids = [...idToRow.keys()];
    console.error(`[sync] enriching ${ids.length} rows from HubSpot…`);
    try {
      const activity = await fetchLastActivity(ids);
      let filled = 0;
      for (const [id, row] of idToRow) {
        const hit = activity.get(id);
        // Always stash the company ID on the row even if HubSpot had no
        // activity for it — useful for future enrichment + debugging.
        row.hubspot_company_id = id;
        if (hit) {
          row.last_activity_at = hit.last_activity_at;
          row.last_activity_source = hit.source;
          filled++;
        }
      }
      const enrichElapsed = ((Date.now() - enrichStarted) / 1000).toFixed(1);
      console.error(
        `[sync] HubSpot enriched ${filled}/${ids.length} rows in ${enrichElapsed}s`
      );
    } catch (e) {
      console.error(
        `[sync] HubSpot enrichment failed (continuing without):`,
        e instanceof Error ? e.message : e
      );
    }
  } else {
    console.error(
      "[sync] HUBSPOT_ACCESS_TOKEN not set — skipping HubSpot enrichment"
    );
  }

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
