import {
  APPROACHING_ENT_SOURCE,
  PAST_DUE_SOURCE,
  runCohortSource,
  type CohortSource,
} from "../data/cohort-sources";
import { kvGet, kvSet } from "../storage/kv";
import { readCohortSnapshot } from "../data/cohort-snapshots";
import { isDemoMode } from "../demo/mode";
import {
  buildDemoApproachingEnt,
  buildDemoPastDue,
} from "../demo/am-fixtures";

/**
 * Cohort fetchers for the AM dashboard tabs.
 *
 * Each cohort comes from a Metabase saved question (q13268 / q24620)
 * that takes 30–90s on the live warehouse. To keep /am snappy we layer
 * four caches, checked in order:
 *
 *   1. **Snapshot file on disk** (data/<cohort>.enc.json) — written by
 *      scripts/sync.ts twice daily. Read in a few ms; always available
 *      in production. Primary path 99% of the time.
 *   2. **In-process memo** (~10 min TTL) — cuts the snapshot decrypt
 *      cost on repeat hits in the same isolate.
 *   3. **Postgres KV** (~30 min fresh, up to 6h stale) — shared cross-
 *      isolate cache. Only used when the file snapshot is missing
 *      (e.g. local dev before sync has been run) — populated lazily on
 *      live fetches.
 *   4. **Live Metabase fetch** — last resort. Only fires if the file
 *      doesn't exist AND the KV is empty or ancient.
 *
 * Column mappings reflect the actual q13268 / q24620 schemas (probed
 * against the live Metabase).
 */

// ─── q13268: Approaching $100K Enterprise pricing ─────────────────────
export interface ApproachingEntRow {
  organization_id: string | null;
  workspace_name: string | null;
  owner_email: string | null;
  owner_name: string | null;
  stripe_customer_id: string | null;
  /** Direct masquerade URL emitted by the Metabase question. */
  masquerade_url: string | null;
  plan_name: string | null;
  billing_interval: string | null;
  max_subscriptions: number | null;
  total_subscriptions: number | null;
  /** Pct of plan cap as a fraction (q13268 returns 0.875 = 87.5%, 1.43 = over). */
  percent_to: number | null;
  remaining: number | null;
  last_send: string | null;
  last_payment_amount: number | null;
  last_payment_at: string | null;
  websites: string | null;
  have_started_t4_recommendations: boolean | null;
  completed_t4_recommendations: boolean | null;
  grew_via_boost: boolean | null;
  monetization_via_boost: boolean | null;
  direct_sponsorships_enabled: boolean | null;
  ad_placement: boolean | null;
  raw: Record<string, unknown>;
}

// ─── q24620: Past-due subscriptions with customer details ─────────────
export interface PastDueRow {
  customer_success_manager: string | null;
  /** Stripe customer ID. */
  customer_id: string | null;
  email: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  /** Stripe plan/price label, e.g. "Scale @ 25,000 - $1785.00/y". */
  price_name: string | null;
  /** Annualized contract value in dollars. */
  arr_dollars: number;
  /** Failed charge amount in dollars. */
  charge_amount_dollars: number;
  charge_status: string | null;
  charge_attempted_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  auto_upgrade: string | null;
  raw: Record<string, unknown>;
}

const APPROACHING_SNAPSHOT_BASENAME = "approaching-enterprise";
const PAST_DUE_SNAPSHOT_BASENAME = "past-due";
/** In-process memo TTL — fast path for repeat hits from the same isolate. */
const MEMO_TTL_MS = 10 * 60 * 1000;
/** KV cache TTL — only used in environments without the snapshot file
 *  (local dev before `npm run sync`). Snapshot reads take precedence. */
const KV_FRESH_TTL_MS = 30 * 60 * 1000;
/** Hard cap on how stale we'll serve KV before forcing a synchronous
 *  Metabase refresh. Past this we'd rather make the user wait than
 *  trust the data. */
const KV_STALE_LIMIT_MS = 6 * 60 * 60 * 1000;
/**
 * How old a cohort snapshot may be before we stop trusting it.
 *
 * sync.ts runs at 08:00 and 16:00 UTC, so the normal worst-case gap is
 * ~16h. 36h clears that plus a missed run without tripping, while still
 * catching a sustained outage long before anyone notices by eye.
 *
 * This exists because it didn't: q24620's source table was dropped on
 * 2026-10-02 and the cohort loop in sync.ts soft-fails per cohort, so
 * the stale file on disk kept being served — unflagged — for 17 days.
 * The `generated_at` below was even being carried into the memo already,
 * labelled "used for the stale check", and then never compared to
 * anything.
 */
const SNAPSHOT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

interface CachedCohort<T> {
  expires: number;
  /** Timestamp the data was generated — used for the stale check. */
  generated_at: number;
  /** Whether `data` is known-stale (see CohortResult.stale). */
  stale: boolean;
  data: T[];
}

/**
 * Rows plus the provenance a caller needs to tell the truth about them.
 *
 * Returning bare `T[]` is what made the 2026-10 outage invisible: a
 * caller had no way to distinguish "263 past-due accounts" from "263
 * past-due accounts as of seventeen days ago".
 */
export interface CohortResult<T> {
  data: T[];
  /** Epoch ms the underlying rows were generated. */
  generated_at: number;
  /** True when we are knowingly serving data past
   *  SNAPSHOT_STALE_AFTER_MS because a refresh was attempted and
   *  failed. Callers should surface this, not hide it. */
  stale: boolean;
}

let approachingMemo: CachedCohort<ApproachingEntRow> | null = null;
let pastDueMemo: CachedCohort<PastDueRow> | null = null;

function asStr(v: unknown): string | null {
  return v == null ? null : String(v);
}
function asNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function asBool(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "t" || s === "true" || s === "1") return true;
  if (s === "f" || s === "false" || s === "0") return false;
  return null;
}

function mapApproaching(row: Record<string, unknown>): ApproachingEntRow {
  return {
    organization_id: asStr(row.organization_id),
    workspace_name: asStr(row.workspace_name),
    owner_email: asStr(row.owner_email),
    owner_name: asStr(row.owner_name),
    stripe_customer_id: asStr(row.stripe_customer_id),
    masquerade_url: asStr(row.masquerade),
    plan_name: asStr(row.plan_name),
    billing_interval: asStr(row.billing_interval),
    max_subscriptions: asNum(row.max_subscriptions),
    total_subscriptions: asNum(row.total_subscriptions),
    percent_to: asNum(row.percent_to),
    remaining: asNum(row.remaining),
    last_send: asStr(row.last_send),
    last_payment_amount: asNum(row.last_payment_amount),
    last_payment_at: asStr(row.last_payment_at),
    websites: asStr(row.websites),
    have_started_t4_recommendations: asBool(row.have_started_t4_recommendations),
    completed_t4_recommendations: asBool(row.completed_t4_recommendations),
    grew_via_boost: asBool(row.grew_via_boost),
    monetization_via_boost: asBool(row.monetization_via_boost),
    direct_sponsorships_enabled: asBool(row.direct_sponsorships_enabled),
    ad_placement: asBool(row.ad_placement),
    raw: row,
  };
}

function mapPastDue(row: Record<string, unknown>): PastDueRow {
  return {
    customer_success_manager: asStr(row.customer_success_manager),
    customer_id: asStr(row.customer_id),
    email: asStr(row.email),
    subscription_id: asStr(row.subscription_id),
    subscription_status: asStr(row.subscription_status),
    price_name: asStr(row.price_name),
    arr_dollars: (asNum(row.arr_cents) ?? 0) / 100,
    charge_amount_dollars: (asNum(row.charge_amount_cents) ?? 0) / 100,
    charge_status: asStr(row.charge_status),
    charge_attempted_at: asStr(row.charge_attempted_at),
    failure_code: asStr(row.failure_code),
    failure_message: asStr(row.failure_message),
    auto_upgrade: asStr(row.auto_upgrade),
    raw: row,
  };
}

interface KvEntry<T> {
  generated_at: number;
  data: T[];
}

/**
 * Four-tier cache: in-process memo → snapshot file → Postgres KV →
 * live Metabase. The snapshot is the happy path in production
 * (written by scripts/sync.ts twice daily); the rest exist so the
 * dashboard keeps working in environments without a sync run.
 *
 * Every tier is age-checked. A snapshot past SNAPSHOT_STALE_AFTER_MS
 * is NOT served as if current: we fall through and try to refresh it.
 * If that refresh also fails we still return the old rows rather than
 * blanking the page — but flagged `stale`, so the UI can say so. The
 * only unacceptable outcome is the one we had: silently confident
 * wrong numbers.
 */
async function loadCohort<T>(
  source: CohortSource,
  snapshotBasename: string,
  kvKey: string,
  mapRow: (row: Record<string, unknown>) => T,
  memo: CachedCohort<T> | null,
  setMemo: (next: CachedCohort<T>) => void
): Promise<CohortResult<T>> {
  const now = Date.now();

  // Tier 1: in-process memo.
  if (memo && memo.expires > now) {
    return {
      data: memo.data,
      generated_at: memo.generated_at,
      stale: memo.stale,
    };
  }

  // Tier 2: snapshot file written by sync.ts. This is the production
  // happy path — `npm run sync` writes data/<basename>.enc.json twice
  // daily, the file ships in the repo, and the dashboard reads it in
  // a few ms with no network round-trip.
  //
  // Held as a fallback rather than returned outright when it's too old,
  // so a failed refresh degrades to flagged-stale instead of an error.
  let staleFallback: CohortResult<T> | null = null;
  try {
    const snap = await readCohortSnapshot(snapshotBasename);
    if (snap && Array.isArray(snap.rows)) {
      const data = snap.rows.map(mapRow);
      const generated_at = new Date(snap.generated_at).getTime() || now;
      const age = now - generated_at;
      if (age <= SNAPSHOT_STALE_AFTER_MS) {
        setMemo({
          expires: now + MEMO_TTL_MS,
          generated_at,
          stale: false,
          data,
        });
        return { data, generated_at, stale: false };
      }
      console.error(
        `[am-cohorts] snapshot ${snapshotBasename} is ${Math.round(
          age / 3_600_000
        )}h old (limit ${SNAPSHOT_STALE_AFTER_MS / 3_600_000}h) — ` +
          `falling through to refresh`
      );
      staleFallback = { data, generated_at, stale: true };
    }
  } catch (e) {
    console.error(
      `[am-cohorts] snapshot read failed for ${snapshotBasename}:`,
      e instanceof Error ? e.message : e
    );
  }

  // Tier 3: cross-isolate Postgres KV. Only relevant in environments
  // where sync hasn't run yet — once a live fetch succeeds we populate
  // this so concurrent isolates skip the slow path.
  let kvHit: KvEntry<T> | null = null;
  try {
    kvHit = await kvGet<KvEntry<T>>(kvKey);
  } catch (e) {
    console.error(`[am-cohorts] KV read failed for ${kvKey}:`, e);
  }

  if (kvHit) {
    const age = now - kvHit.generated_at;
    if (age <= KV_FRESH_TTL_MS) {
      setMemo({
        expires: now + MEMO_TTL_MS,
        generated_at: kvHit.generated_at,
        stale: false,
        data: kvHit.data,
      });
      return { data: kvHit.data, generated_at: kvHit.generated_at, stale: false };
    }
    if (age <= KV_STALE_LIMIT_MS) {
      // Stale-but-not-ancient: serve immediately, refresh in background.
      void refreshAndStore(source, kvKey, mapRow).catch((e) =>
        console.error(`[am-cohorts] background refresh of ${kvKey} failed:`, e)
      );
      setMemo({
        expires: now + MEMO_TTL_MS,
        generated_at: kvHit.generated_at,
        stale: false,
        data: kvHit.data,
      });
      return { data: kvHit.data, generated_at: kvHit.generated_at, stale: false };
    }
  }

  // Tier 4: live Metabase fetch — last resort.
  try {
    const data = await refreshAndStore(source, kvKey, mapRow);
    setMemo({ expires: now + MEMO_TTL_MS, generated_at: now, stale: false, data });
    return { data, generated_at: now, stale: false };
  } catch (e) {
    if (staleFallback) {
      // The question itself is broken (this is exactly the q24620 case).
      // Serving the old rows beats an empty tab, but the caller gets
      // `stale: true` and must say so. Memoised so a broken question
      // isn't re-hit on every single request.
      console.error(
        `[am-cohorts] refresh of ${source.label} failed, serving stale ` +
          `${snapshotBasename} from ${new Date(
            staleFallback.generated_at
          ).toISOString()}:`,
        e instanceof Error ? e.message : e
      );
      setMemo({
        expires: now + MEMO_TTL_MS,
        generated_at: staleFallback.generated_at,
        stale: true,
        data: staleFallback.data,
      });
      return staleFallback;
    }
    throw e;
  }
}

async function refreshAndStore<T>(
  source: CohortSource,
  kvKey: string,
  mapRow: (row: Record<string, unknown>) => T
): Promise<T[]> {
  const rows = (await runCohortSource(source)) as Array<
    Record<string, unknown>
  >;
  const data = rows.map(mapRow);
  try {
    await kvSet<KvEntry<T>>(kvKey, { generated_at: Date.now(), data });
  } catch (e) {
    console.error(`[am-cohorts] KV write failed for ${kvKey}:`, e);
  }
  return data;
}

/**
 * Cohort loaders come in pairs.
 *
 * The bare `loadX()` returns rows and is what the engines, the MCP
 * tools and the history sweep want — they aggregate, and provenance
 * doesn't change what they compute. The `loadXWithMeta()` variant adds
 * `generated_at` + `stale` and is what any SURFACE should call, because
 * a screen that shows numbers to a human owes them the date those
 * numbers are from. Both share the same memo, so pairing costs nothing.
 */
export async function loadApproachingEnterpriseWithMeta(): Promise<
  CohortResult<ApproachingEntRow>
> {
  if (isDemoMode()) {
    return {
      data: buildDemoApproachingEnt(),
      generated_at: Date.now(),
      stale: false,
    };
  }
  return loadCohort<ApproachingEntRow>(
    APPROACHING_ENT_SOURCE,
    APPROACHING_SNAPSHOT_BASENAME,
    "am-cohorts:approaching-ent:v1",
    mapApproaching,
    approachingMemo,
    (next) => {
      approachingMemo = next;
    }
  );
}

export async function loadApproachingEnterprise(): Promise<ApproachingEntRow[]> {
  return (await loadApproachingEnterpriseWithMeta()).data;
}

export async function loadPastDueWithMeta(): Promise<CohortResult<PastDueRow>> {
  if (isDemoMode()) {
    return { data: buildDemoPastDue(), generated_at: Date.now(), stale: false };
  }
  return loadCohort<PastDueRow>(
    PAST_DUE_SOURCE,
    PAST_DUE_SNAPSHOT_BASENAME,
    "am-cohorts:past-due:v1",
    mapPastDue,
    pastDueMemo,
    (next) => {
      pastDueMemo = next;
    }
  );
}

export async function loadPastDue(): Promise<PastDueRow[]> {
  return (await loadPastDueWithMeta()).data;
}
