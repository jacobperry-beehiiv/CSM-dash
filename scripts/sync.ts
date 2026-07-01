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
import { readSnapshot } from "../src/lib/data/snapshot-loader";
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
 * "All enterprise multi-month renewals" — Stripe customers whose
 * billing cadence isn't a vanilla monthly or annual (quarterly,
 * semi-annual, biennial, etc.). Each row carries the explicit
 * `interval_count` (months between charges) that lets the Renewals
 * tab bucket the customer by their actual cadence.
 *
 * Source: https://beehiiv.metabaseapp.com/question/23101-all-enterprise-multi-month-renewals
 *
 * Joined into the main snapshot at sync time on stripe_customer_id —
 * we don't write a separate cohort snapshot because the data is
 * cleanest to consume as a field on the existing Customer row.
 */
const MULTI_MONTH_QUESTION_ID = 23101;

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
  // `--only=deliverability` short-circuits the full Metabase + HubSpot
  // pull and runs ONLY the ClickHouse-backed deliverability snapshot
  // block. Used by the dashboard-driven "Refresh data" button so a CSM
  // can get a fresh snapshot in ~60s instead of waiting for the next
  // 08/16 UTC tick of the full sync.
  const onlyDeliverability = process.argv.includes("--only=deliverability");

  const usePlaintext = process.env.SYNC_PLAINTEXT === "1";
  if (!usePlaintext && !process.env.SNAPSHOT_ENCRYPTION_KEY) {
    throw new Error(
      "SNAPSHOT_ENCRYPTION_KEY not set. Generate one with `openssl rand -base64 32` and add it to .env.local + GitHub Actions secrets."
    );
  }

  if (onlyDeliverability) {
    await syncDeliverability(usePlaintext);
    return;
  }

  if (!process.env.METABASE_URL) {
    throw new Error(
      "METABASE_URL not set — run via `npm run sync` (which loads .env.local) or export the vars manually."
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

  // ─── Multi-month renewal enrichment (q23101) ──────────────────────
  // Stripe customers on cadences that aren't a vanilla "month" or
  // "year" (quarterly, semi-annual, biennial, etc.) come back from
  // q10600 with `interval: "month"` even though their billing trigger
  // is N months apart. q23101 surfaces the explicit interval_count
  // for these — join on stripe_customer_id and stamp interval_count
  // onto the matching customer row so the Renewals tab can bucket
  // them as Quarterly / Semi-annual / Biennial / etc. instead of
  // mis-classifying as monthly.
  //
  // Soft-fail: if q23101 errors or returns zero rows, the main
  // snapshot still writes (with interval_count unset on every row,
  // which falls back to the existing interval-string bucket logic).
  try {
    console.error(`[sync] pulling q${MULTI_MONTH_QUESTION_ID} (multi-month renewals)…`);
    const multiMonthStarted = Date.now();
    const multiMonthRows = (await runSavedQuestion(
      MULTI_MONTH_QUESTION_ID
    )) as Record<string, unknown>[];
    // Build a stripe_customer_id → interval_count index. q23101 may
    // return multiple rows per customer (one per active subscription
    // / line item); we take the FIRST interval_count we see, since
    // the renewals tab cares about the dominant billing cadence.
    const intervalCountByStripeId = new Map<string, number>();
    for (const row of multiMonthRows) {
      const sid =
        typeof row.stripe_customer_id === "string" && row.stripe_customer_id
          ? row.stripe_customer_id
          : null;
      const count =
        typeof row.interval_count === "number"
          ? row.interval_count
          : typeof row.interval_count === "string"
            ? Number(row.interval_count)
            : null;
      if (!sid || count == null || !Number.isFinite(count) || count <= 0) {
        continue;
      }
      if (!intervalCountByStripeId.has(sid)) {
        intervalCountByStripeId.set(sid, count);
      }
    }
    let stamped = 0;
    for (const r of rows as Record<string, unknown>[]) {
      const sid =
        typeof r.stripe_customer_id === "string" && r.stripe_customer_id
          ? r.stripe_customer_id
          : null;
      if (!sid) continue;
      const count = intervalCountByStripeId.get(sid);
      if (count != null) {
        r.interval_count = count;
        stamped++;
      }
    }
    const multiMonthElapsed = (
      (Date.now() - multiMonthStarted) /
      1000
    ).toFixed(1);
    console.error(
      `[sync] multi-month renewals: ${multiMonthRows.length} rows from q${MULTI_MONTH_QUESTION_ID}, ${stamped} stamped onto customers in ${multiMonthElapsed}s`
    );
  } catch (e) {
    console.error(
      `[sync] q${MULTI_MONTH_QUESTION_ID} multi-month renewals enrichment failed (continuing):`,
      e instanceof Error ? e.message : e
    );
  }

  const payload = {
    generated_at: new Date().toISOString(),
    question_id: QUESTION_ID,
    row_count: rows.length,
    rows,
  };

  // ─── ARR sanity check ─────────────────────────────────────────────
  // On the 1st of a new month, cohort_analysis.internal_profitwell in
  // Metabase lags into the new month by several hours. q10600's SQL
  // filters strictly on `where month = date_trunc('month', current_date)`,
  // so during that window every row's mrr joins null and arr
  // computes to 0. Committing that snapshot would wipe ARR on every
  // page of the live dashboard until the next successful sync.
  //
  // Refuse the write when incoming rows sum to 0 ARR AND the existing
  // snapshot on disk has a non-zero total — a strong signal we're
  // catching a bad Metabase state rather than a legitimate empty book.
  // `SYNC_ALLOW_ZERO_ARR=1` overrides the check for the rare case
  // where 0 ARR is actually correct (test fixture, first-ever sync).
  const incomingArr = rows.reduce(
    (s, r) => s + (typeof r.arr === "number" ? r.arr : Number(r.arr) || 0),
    0
  );
  if (incomingArr === 0 && process.env.SYNC_ALLOW_ZERO_ARR !== "1") {
    let previousArr = 0;
    try {
      const previous = await readSnapshot();
      previousArr = (previous.rows ?? []).reduce(
        (s: number, r: Record<string, unknown>) =>
          s +
          (typeof r.arr === "number" ? r.arr : Number(r.arr as unknown) || 0),
        0
      );
    } catch (e) {
      console.error(
        `[sync] Couldn't read previous snapshot for ARR sanity check — ` +
          `letting the write proceed since there's no baseline to compare against:`,
        e instanceof Error ? e.message : e
      );
    }
    if (previousArr > 0) {
      console.error(
        `[sync] REFUSING TO WRITE SNAPSHOT: incoming total ARR is $0 ` +
          `across ${rows.length} rows, but previous snapshot totals ` +
          `$${previousArr.toLocaleString()}. This is almost always a ` +
          `Metabase data-freshness issue (typically cohort_analysis.` +
          `internal_profitwell hasn't rolled into the current month yet). ` +
          `The existing snapshot stays live so the dashboard doesn't ` +
          `flatten to $0. Retry the sync once Profitwell catches up, or ` +
          `set SYNC_ALLOW_ZERO_ARR=1 to override.`
      );
      process.exit(1);
    }
    console.error(
      `[sync] Incoming ARR is $0 and previous snapshot ARR was $0 too — ` +
        `letting the write proceed (fresh install or intentionally-empty book).`
    );
  }

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
  // Same self-contained block the `--only=deliverability` path runs.
  await syncDeliverability(usePlaintext);
}

/** Pre-compute the joined Q1-Q4 ClickHouse result for the last 15
 *  days so /csm?tab=deliverability reads from disk instead of waiting
 *  30–60s on 4 separate ClickHouse queries. Self-contained (no
 *  Metabase / HubSpot deps) so it can run standalone via the
 *  `--only=deliverability` flag the dashboard-driven refresh uses. */
async function syncDeliverability(usePlaintext: boolean) {
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

main().catch((err) => {
  console.error("[sync] failed:", err.message ?? err);
  process.exit(1);
});
