import { runSavedQuestion } from "../metabase";
import type { Customer, DataSource, Segment } from "../types";
import { loadCustomersFromSnapshot, snapshotMetadata } from "./snapshot-loader";
import { metabaseRowToCustomer } from "./metabase-mapper";
import { applyOverride, loadOverrides } from "./customer-overrides";

export function getDataSource(): DataSource {
  const raw = (process.env.DATA_SOURCE ?? "").toLowerCase().trim();
  if (raw === "snapshot") return "snapshot";
  if (raw === "metabase") return "metabase";
  return "snapshot";
}

/**
 * Cache holds the RAW customer set (no overrides applied). Overrides are
 * re-applied on every loadCustomers() call from a fresh KV read, so a
 * cadence toggle on one isolate is visible to every other isolate
 * immediately — even if the customer-list cache is still warm there.
 *
 * The decrypt + parse for `snapshot` mode is the slow part (~50-200ms);
 * keeping the raw rows in memory for 60s makes warm-isolate request
 * latency negligible. Override application is just an `.map()` over the
 * array, microseconds.
 */
let rawCache: { source: DataSource; data: Customer[]; expires: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function loadRawCustomers(): Promise<Customer[]> {
  const source = getDataSource();
  const now = Date.now();
  if (rawCache && rawCache.source === source && rawCache.expires > now) {
    return rawCache.data;
  }

  let raw: Customer[];
  if (source === "snapshot") {
    raw = await loadCustomersFromSnapshot();
  } else {
    const rows = (await runSavedQuestion(10600)) as Record<string, unknown>[];
    raw = rows.map(metabaseRowToCustomer);
  }

  rawCache = { source, data: raw, expires: now + CACHE_TTL_MS };
  return raw;
}

export async function loadCustomers(): Promise<Customer[]> {
  const raw = await loadRawCustomers();
  const overrides = await loadOverrides();
  return raw.map((c) => applyOverride(c, overrides));
}

/** Bust the loadCustomers raw cache — only useful for snapshot rotation. */
export function invalidateCustomerCache() {
  rawCache = null;
}

export async function dataSourceMeta(): Promise<{
  source: DataSource;
  generatedAt: string | null;
  rowCount: number | null;
  ageMs: number | null;
}> {
  const source = getDataSource();
  if (source === "snapshot") {
    const meta = await snapshotMetadata();
    return {
      source,
      generatedAt: meta?.generatedAt ?? null,
      rowCount: meta?.rowCount ?? null,
      ageMs: meta?.ageMs ?? null,
    };
  }
  return { source, generatedAt: null, rowCount: null, ageMs: null };
}

export interface FilterOpts {
  csm?: string | null;
  segment?: Segment;
}

export function filterCustomers(
  customers: Customer[],
  opts: FilterOpts = {}
): Customer[] {
  let list = customers;
  if (opts.csm) {
    list = list.filter((c) => c.customer_success_manager === opts.csm);
  }
  if (opts.segment === "enterprise") {
    list = list.filter((c) => isEnterprise(c));
  } else if (opts.segment === "growth") {
    list = list.filter((c) => !isEnterprise(c));
  }
  return list;
}

export function isEnterprise(c: Customer): boolean {
  const plan = (c.stripe_plan ?? "").toLowerCase();
  return plan.includes("enterprise");
}

export function uniqueCsms(customers: Customer[]): string[] {
  const set = new Set<string>();
  for (const c of customers) {
    if (c.customer_success_manager) set.add(c.customer_success_manager);
  }
  return [...set].sort();
}
