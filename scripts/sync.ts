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
import { writeDeliverabilitySnapshot } from "../src/lib/data/deliverability-snapshot";
import { fetchDeliverabilityPosts } from "../src/lib/engines/deliverability";
import {
  fetchLastActivity,
  fetchLastActivityByEmail,
  searchCompaniesByStripeIds,
} from "../src/lib/integrations/hubspot";

const DELIVERABILITY_LOOKBACK_DAYS = 15;

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
  // Resolve each row's HubSpot company link via the Stripe customer ID
  // custom property on the HubSpot company record. Stripe IDs are
  // stable across HubSpot company merges / record drift in a way that
  // q10600's hubspot_company_id column isn't — so we use them as the
  // primary join key and stamp the resolved company ID onto the row.
  //
  // Fallback chain:
  //   1. stripe_customer_id → searchCompaniesByStripeIds (primary)
  //   2. owner_email → fetchLastActivityByEmail (only when (1) misses)
  //   3. No HubSpot link
  //
  // Sets the new `hubspot_link_source` field on each row so the UI
  // can show a confidence indicator. Soft-fails: if HubSpot auth is
  // missing or the API errors, sync continues with the un-enriched
  // rows (hubspot_link_source stays unset).
  const hasHubSpotAuth =
    !!process.env.HUBSPOT_ACCESS_TOKEN ||
    (!!process.env.HUBSPOT_CLIENT_ID && !!process.env.HUBSPOT_CLIENT_SECRET);
  if (hasHubSpotAuth) {
    const enrichStarted = Date.now();
    const typedRows = rows as Record<string, unknown>[];

    // Bucket rows by stripe_customer_id (primary) and owner_email
    // (fallback). One row can only land in one bucket — if it has a
    // Stripe ID we always try that first and only fall back to email
    // if the Stripe-ID lookup misses.
    const stripeToRows = new Map<string, Record<string, unknown>[]>();
    const emailToRow = new Map<string, Record<string, unknown>>();
    for (const r of typedRows) {
      const stripeId =
        typeof r.stripe_customer_id === "string" && r.stripe_customer_id
          ? r.stripe_customer_id
          : null;
      if (stripeId) {
        const arr = stripeToRows.get(stripeId) ?? [];
        arr.push(r);
        stripeToRows.set(stripeId, arr);
      }
      const email =
        typeof r.owner_email === "string" && r.owner_email
          ? r.owner_email.toLowerCase()
          : null;
      if (email && !emailToRow.has(email)) emailToRow.set(email, r);
    }

    try {
      const stripeIds = [...stripeToRows.keys()];
      let resolvedByStripe = 0;
      let resolvedByEmail = 0;
      let unresolved = 0;
      let stripeMismatch = 0;

      // ─── Pass 1: Stripe-ID lookup ───
      if (stripeIds.length > 0) {
        console.error(
          `[sync] resolving ${stripeIds.length} unique Stripe IDs via HubSpot search…`
        );
        const stripeMatches = await searchCompaniesByStripeIds(stripeIds);
        for (const [stripeId, rowsForStripeId] of stripeToRows) {
          const match = stripeMatches.get(stripeId);
          if (!match) continue;
          for (const row of rowsForStripeId) {
            // Detect drift between q10600's hubspot_company_id column
            // and what the Stripe-ID search returned — likely a
            // HubSpot company merge upstream. Stripe-ID is canonical
            // (per the design), so overwrite the column but stash a
            // warning on the row so the UI can flag it.
            const q10600Id =
              typeof row.hubspot_company_id === "string" &&
              row.hubspot_company_id
                ? row.hubspot_company_id
                : null;
            if (q10600Id && q10600Id !== match.companyId) {
              row.hubspot_link_warning = `q10600 said company ${q10600Id}, Stripe-ID lookup resolved ${match.companyId}`;
              stripeMismatch++;
            } else {
              row.hubspot_link_warning = null;
            }
            row.hubspot_company_id = match.companyId;
            row.hubspot_link_source = "stripe_id";
            if (match.activity?.last_activity_at) {
              row.last_activity_at = match.activity.last_activity_at;
              row.last_activity_source = match.activity.source;
            }
            resolvedByStripe++;
          }
        }
      }

      // Fold in the existing contact-fetch behavior from
      // fetchLastActivity() for everyone we just resolved via Stripe
      // ID. The search returned activity rollups inline (last activity
      // + source) but NOT the hubspot_contacts list — that lives on
      // the v4 associations endpoint, which is still in fetchLastActivity.
      const stripeResolvedIds: string[] = [];
      for (const r of typedRows) {
        if (
          r.hubspot_link_source === "stripe_id" &&
          typeof r.hubspot_company_id === "string"
        ) {
          stripeResolvedIds.push(r.hubspot_company_id);
        }
      }
      if (stripeResolvedIds.length > 0) {
        console.error(
          `[sync] backfilling contacts for ${stripeResolvedIds.length} Stripe-resolved rows…`
        );
        const activity = await fetchLastActivity(stripeResolvedIds);
        const idToRow = new Map<string, Record<string, unknown>>();
        for (const r of typedRows) {
          if (
            r.hubspot_link_source === "stripe_id" &&
            typeof r.hubspot_company_id === "string"
          ) {
            idToRow.set(r.hubspot_company_id, r);
          }
        }
        for (const [id, row] of idToRow) {
          const hit = activity.get(id);
          if (hit?.contacts && hit.contacts.length > 0) {
            row.hubspot_contacts = hit.contacts;
          }
        }
      }

      // ─── Pass 2: owner_email fallback for rows the Stripe-ID
      // search missed. Skip rows already resolved by stripe_id. ───
      const fallbackEmails = new Map<string, Record<string, unknown>>();
      for (const [email, row] of emailToRow) {
        if (row.hubspot_link_source === "stripe_id") continue;
        fallbackEmails.set(email, row);
      }
      if (fallbackEmails.size > 0) {
        console.error(
          `[sync] Stripe-ID lookup missed ${fallbackEmails.size} rows — falling back to owner_email…`
        );
        const activity = await fetchLastActivityByEmail([
          ...fallbackEmails.keys(),
        ]);
        for (const [email, row] of fallbackEmails) {
          const hit = activity.get(email);
          if (hit) {
            row.last_activity_at = hit.last_activity_at;
            row.last_activity_source = hit.source;
            if (hit.contacts && hit.contacts.length > 0) {
              row.hubspot_contacts = hit.contacts;
            }
            row.hubspot_link_source = "email_fallback";
            resolvedByEmail++;
          }
        }
      }

      // ─── Final pass: mark everyone still un-resolved. ───
      for (const r of typedRows) {
        if (!r.hubspot_link_source) {
          r.hubspot_link_source = "none";
          unresolved++;
        }
      }

      const enrichElapsed = ((Date.now() - enrichStarted) / 1000).toFixed(1);
      console.error(
        `[sync] HubSpot resolution complete in ${enrichElapsed}s: ${resolvedByStripe} via Stripe ID${
          stripeMismatch > 0 ? ` (${stripeMismatch} drift-corrected)` : ""
        }, ${resolvedByEmail} via email, ${unresolved} unresolved`
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

  // ─── Deliverability snapshot ──────────────────────────────────────
  // Pre-compute the joined Q1-Q4 ClickHouse result for the last 15
  // days so /csm?tab=deliverability reads from disk instead of waiting
  // 30–60s on 4 separate ClickHouse queries. Thresholds are applied at
  // request time, so /settings/general edits take effect immediately
  // without a resync.
  {
    const started = Date.now();
    try {
      console.error(
        `[sync] pulling deliverability (last ${DELIVERABILITY_LOOKBACK_DAYS}d posts + spam for recent dates)…`
      );
      const { posts, spam_dates } = await fetchDeliverabilityPosts(
        DELIVERABILITY_LOOKBACK_DAYS
      );
      const written = await writeDeliverabilitySnapshot(
        {
          generated_at: new Date().toISOString(),
          lookback_days: DELIVERABILITY_LOOKBACK_DAYS,
          row_count: posts.length,
          posts,
          spam_dates,
        },
        { plaintext: usePlaintext }
      );
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.error(
        `[sync] wrote ${written} (${posts.length} posts, spam dates: ${
          spam_dates.length ? spam_dates.join(", ") : "none"
        }, ${elapsed}s)`
      );
    } catch (e) {
      console.error(
        "[sync] deliverability snapshot failed (continuing):",
        e instanceof Error ? e.message : e
      );
    }
  }
}

main().catch((err) => {
  console.error("[sync] failed:", err.message ?? err);
  process.exit(1);
});
