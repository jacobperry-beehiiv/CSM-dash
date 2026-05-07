import { runSavedQuestion } from "../metabase";

/**
 * Cohort fetchers for the AM dashboard tabs that pull from existing
 * Metabase saved questions. Each call is cached in-process for 10 min so
 * tab switches are instant after the first hit.
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
const TTL_MS = 10 * 60 * 1000;

let approachingCache: { expires: number; data: ApproachingEntRow[] } | null =
  null;
let pastDueCache: { expires: number; data: PastDueRow[] } | null = null;

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

export async function loadApproachingEnterprise(): Promise<ApproachingEntRow[]> {
  const now = Date.now();
  if (approachingCache && approachingCache.expires > now) {
    return approachingCache.data;
  }
  const rows = (await runSavedQuestion(APPROACHING_ENT_QUESTION_ID)) as Array<
    Record<string, unknown>
  >;
  const data: ApproachingEntRow[] = rows.map((row) => ({
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
  }));
  approachingCache = { expires: now + TTL_MS, data };
  return data;
}

export async function loadPastDue(): Promise<PastDueRow[]> {
  const now = Date.now();
  if (pastDueCache && pastDueCache.expires > now) return pastDueCache.data;
  const rows = (await runSavedQuestion(PAST_DUE_QUESTION_ID)) as Array<
    Record<string, unknown>
  >;
  const data: PastDueRow[] = rows.map((row) => ({
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
  }));
  pastDueCache = { expires: now + TTL_MS, data };
  return data;
}
