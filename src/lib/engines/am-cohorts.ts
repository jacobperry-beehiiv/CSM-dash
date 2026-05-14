import { runSavedQuestion } from "../metabase";
import { kvGet, kvSet } from "../storage/kv";

/**
 * Cohort fetchers for the AM dashboard tabs.
 *
 * Each cohort runs a Metabase saved question (q13268 / q24620) against
 * the live warehouse. Those queries take 30–90s on first hit, which
 * makes the /am page feel sluggish — especially on Vercel where each
 * cold isolate would otherwise pay the full cost.
 *
 * Caching strategy (in order of preference):
 *
 *   1. **In-process memo** (~10 min TTL) — fastest. Subsequent calls
 *      from the same isolate are zero-cost.
 *   2. **Postgres KV** (~30 min TTL) — shared across isolates. After
 *      one isolate populates it, every other isolate (warm or cold)
 *      reads from KV in <50ms.
 *   3. **Stale-while-revalidate** — if the KV value is past its TTL but
 *      not too far past, serve it immediately and kick off a background
 *      Metabase refresh. Means the user never waits on Metabase except
 *      on the very first ever load.
 *   4. **Live Metabase fetch** — fallback when nothing is cached or
 *      the cached value is too old to use.
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

const APPROACHING_ENT_QUESTION_ID = 13268;
const PAST_DUE_QUESTION_ID = 24620;
/** In-process memo TTL — fast path for repeat hits from the same isolate. */
const MEMO_TTL_MS = 10 * 60 * 1000;
/** KV cache TTL — fresh enough to be useful, long enough to make cold
 *  isolates feel snappy. */
const KV_FRESH_TTL_MS = 30 * 60 * 1000;
/** Hard cap on how stale we'll serve before forcing a synchronous
 *  Metabase refresh. Past this we'd rather make the user wait than
 *  trust the data. */
const KV_STALE_LIMIT_MS = 6 * 60 * 60 * 1000;

interface CachedCohort<T> {
  expires: number;
  /** Timestamp the data was generated — used for the stale check. */
  generated_at: number;
  data: T[];
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
 * Three-tier cache: in-process memo → Postgres KV → live Metabase.
 * Stale entries from KV are returned immediately while a background
 * refresh kicks off, so the user never sees a spinner for known data.
 */
async function loadCohort<T>(
  questionId: number,
  kvKey: string,
  mapRow: (row: Record<string, unknown>) => T,
  memo: CachedCohort<T> | null,
  setMemo: (next: CachedCohort<T>) => void
): Promise<T[]> {
  const now = Date.now();

  // Tier 1: in-process memo.
  if (memo && memo.expires > now) return memo.data;

  // Tier 2: cross-isolate Postgres KV.
  let kvHit: KvEntry<T> | null = null;
  try {
    kvHit = await kvGet<KvEntry<T>>(kvKey);
  } catch (e) {
    // KV read failed (Postgres down etc.) — fall through to a live fetch.
    console.error(`[am-cohorts] KV read failed for ${kvKey}:`, e);
  }

  if (kvHit) {
    const age = now - kvHit.generated_at;
    if (age <= KV_FRESH_TTL_MS) {
      // Fresh enough — populate memo and return.
      setMemo({
        expires: now + MEMO_TTL_MS,
        generated_at: kvHit.generated_at,
        data: kvHit.data,
      });
      return kvHit.data;
    }
    if (age <= KV_STALE_LIMIT_MS) {
      // Stale but not ancient — serve it immediately, refresh in
      // background so the next caller gets fresh data. We deliberately
      // don't await this; failures are non-fatal (the next request will
      // try again).
      void refreshAndStore(questionId, kvKey, mapRow).catch((e) =>
        console.error(`[am-cohorts] background refresh of ${kvKey} failed:`, e)
      );
      setMemo({
        expires: now + MEMO_TTL_MS,
        generated_at: kvHit.generated_at,
        data: kvHit.data,
      });
      return kvHit.data;
    }
    // Past the stale limit — fall through to a synchronous refresh.
  }

  // Tier 3: live Metabase fetch.
  const data = await refreshAndStore(questionId, kvKey, mapRow);
  setMemo({ expires: now + MEMO_TTL_MS, generated_at: now, data });
  return data;
}

async function refreshAndStore<T>(
  questionId: number,
  kvKey: string,
  mapRow: (row: Record<string, unknown>) => T
): Promise<T[]> {
  const rows = (await runSavedQuestion(questionId)) as Array<
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

export async function loadApproachingEnterprise(): Promise<ApproachingEntRow[]> {
  return loadCohort<ApproachingEntRow>(
    APPROACHING_ENT_QUESTION_ID,
    "am-cohorts:approaching-ent:v1",
    mapApproaching,
    approachingMemo,
    (next) => {
      approachingMemo = next;
    }
  );
}

export async function loadPastDue(): Promise<PastDueRow[]> {
  return loadCohort<PastDueRow>(
    PAST_DUE_QUESTION_ID,
    "am-cohorts:past-due:v1",
    mapPastDue,
    pastDueMemo,
    (next) => {
      pastDueMemo = next;
    }
  );
}
