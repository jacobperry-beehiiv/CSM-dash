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
import { writeCohortSnapshot } from "../src/lib/data/cohort-snapshots";
import {
  fetchLastActivity,
  fetchLastActivityByEmail,
} from "../src/lib/integrations/hubspot";

const QUESTION_ID = 10600;
const PLAINTEXT_PATH = path.join(process.cwd(), "data/snapshot.json");
const ENCRYPTED_PATH = path.join(process.cwd(), "data/snapshot.enc.json");

/**
 * Additional Metabase saved questions pre-computed by sync so the /am
 * tabs can read from disk instead of waiting 30–90s on a live query.
 * Each entry pairs a saved-question ID with the basename used by the
 * cohort-snapshot reader.
 */
const COHORT_QUESTIONS: Array<{ id: number; basename: string; label: string }> = [
  { id: 13268, basename: "approaching-enterprise", label: "approaching-enterprise" },
  { id: 24620, basename: "past-due", label: "past-due" },
];

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
  // it onto the row. Soft-fails: if neither HUBSPOT_ACCESS_TOKEN nor
  // HUBSPOT_CLIENT_ID+HUBSPOT_CLIENT_SECRET are set, or the HubSpot
  // API errors, sync continues with the un-enriched rows.
  const hasHubSpotAuth =
    !!process.env.HUBSPOT_ACCESS_TOKEN ||
    (!!process.env.HUBSPOT_CLIENT_ID && !!process.env.HUBSPOT_CLIENT_SECRET);
  if (hasHubSpotAuth) {
    const enrichStarted = Date.now();
    const typedRows = rows as Record<string, unknown>[];

    // Path A: rows already carry a HubSpot company ID — fastest.
    const idToRow = new Map<string, Record<string, unknown>>();
    for (const r of typedRows) {
      const id = pickCompanyId(r);
      if (id) idToRow.set(id, r);
    }
    const idsAvailable = idToRow.size;

    // Path B: fall back to owner_email lookup when no company IDs are
    // present. q10600 doesn't expose hs_object_id today; this lets us
    // ship enrichment without waiting on a Metabase question edit.
    const emailToRow = new Map<string, Record<string, unknown>>();
    if (idsAvailable === 0) {
      for (const r of typedRows) {
        const email =
          typeof r.owner_email === "string" && r.owner_email
            ? r.owner_email.toLowerCase()
            : null;
        if (email && !emailToRow.has(email)) emailToRow.set(email, r);
      }
    }

    try {
      let filled = 0;
      if (idsAvailable > 0) {
        console.error(
          `[sync] enriching ${idsAvailable} rows from HubSpot by company ID…`
        );
        const activity = await fetchLastActivity([...idToRow.keys()]);
        for (const [id, row] of idToRow) {
          row.hubspot_company_id = id;
          const hit = activity.get(id);
          if (hit) {
            row.last_activity_at = hit.last_activity_at;
            row.last_activity_source = hit.source;
            if (hit.contacts && hit.contacts.length > 0) {
              row.hubspot_contacts = hit.contacts;
            }
            filled++;
          }
        }
      } else if (emailToRow.size > 0) {
        console.error(
          `[sync] no company IDs in q10600 — enriching ${emailToRow.size} rows from HubSpot by owner_email…`
        );
        const activity = await fetchLastActivityByEmail([...emailToRow.keys()]);
        for (const [email, row] of emailToRow) {
          const hit = activity.get(email);
          if (hit) {
            row.last_activity_at = hit.last_activity_at;
            row.last_activity_source = hit.source;
            if (hit.contacts && hit.contacts.length > 0) {
              row.hubspot_contacts = hit.contacts;
            }
            filled++;
          }
        }
      } else {
        console.error(
          "[sync] no HubSpot company IDs or owner_emails found — nothing to enrich"
        );
      }
      const enrichElapsed = ((Date.now() - enrichStarted) / 1000).toFixed(1);
      console.error(
        `[sync] HubSpot enriched ${filled} rows in ${enrichElapsed}s`
      );
    } catch (e) {
      console.error(
        `[sync] HubSpot enrichment failed (continuing without):`,
        e instanceof Error ? e.message : e
      );
    }
  } else {
    console.error(
      "[sync] HubSpot auth not configured (set HUBSPOT_ACCESS_TOKEN or " +
        "HUBSPOT_CLIENT_ID+HUBSPOT_CLIENT_SECRET) — skipping HubSpot enrichment"
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

  // ─── AM cohort snapshots ───────────────────────────────────────────
  // Pre-compute the slow /am tabs (q13268 + q24620) so they read from
  // disk in <50ms instead of waiting on a live Metabase query. Each
  // cohort soft-fails independently — a failure here never blocks the
  // main book of business from shipping.
  for (const cohort of COHORT_QUESTIONS) {
    const started = Date.now();
    try {
      console.error(`[sync] pulling q${cohort.id} (${cohort.label})…`);
      const cohortRows = await runSavedQuestion(cohort.id);
      const written = await writeCohortSnapshot(
        cohort.basename,
        {
          generated_at: new Date().toISOString(),
          question_id: cohort.id,
          row_count: cohortRows.length,
          rows: cohortRows,
        },
        { plaintext: usePlaintext }
      );
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.error(
        `[sync] wrote ${written} (${cohortRows.length} rows, ${elapsed}s)`
      );
    } catch (e) {
      console.error(
        `[sync] cohort q${cohort.id} (${cohort.label}) failed (continuing):`,
        e instanceof Error ? e.message : e
      );
    }
  }
}

main().catch((err) => {
  console.error("[sync] failed:", err.message ?? err);
  process.exit(1);
});
