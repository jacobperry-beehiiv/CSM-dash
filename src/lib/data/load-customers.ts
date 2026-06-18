import { runSavedQuestion } from "../metabase";
import type { Customer, DataSource, Segment } from "../types";
import { loadCustomersFromSnapshot, snapshotMetadata } from "./snapshot-loader";
import { metabaseRowToCustomer } from "./metabase-mapper";
import { applyOverride, loadOverrides } from "./customer-overrides";
import { TEST_CUSTOMER } from "./test-customer";
import { isDemoMode } from "../demo/mode";
import { buildDemoCustomers } from "../demo/customer-fixture";

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

/**
 * "Enrichment score" for picking the best row when q10600 emits more
 * than one row per workspace (the join that backs q10600 multiplies
 * for ~4 customers today). Rows with HubSpot contacts or a populated
 * `last_activity_at` beat rows without — those fields are written by
 * the sync-time HubSpot enrichment step against `owner_email`, and
 * Metabase doesn't double them across the duplicated rows, so when a
 * workspace is duplicated only one copy ends up enriched.
 */
function enrichmentScore(c: Customer): number {
  let score = 0;
  if (c.hubspot_contacts && c.hubspot_contacts.length > 0) score += 10;
  if (c.last_activity_at) score += 4;
  if (c.hubspot_company_id) score += 2;
  // Tiebreakers — prefer the row with the most non-null fields, on
  // the assumption that more populated = more reliable.
  for (const k of Object.keys(c) as (keyof Customer)[]) {
    if (c[k] != null) score += 0.01;
  }
  return score;
}

/**
 * Collapse duplicate `workspace_id` rows down to one. Keeps the
 * highest-enrichment-scoring copy so HubSpot contacts and activity
 * dates survive. Rows without a workspace_id are passed through
 * untouched — they can't dedupe.
 *
 * Background: q10600's underlying join multiplies for a handful of
 * workspaces (4 as of 2026-05-21 — Togethxr, Sckale, HangarX, Civic
 * News). Without dedupe the renewals tab shows the same customer
 * multiple times, the customer-table search surfaces dupes, the
 * dashboard's ARR total overcounts by tens of thousands, and the
 * "Email selected" launcher will draft two emails to the same
 * customer.
 */
function dedupeByWorkspace(rows: Customer[]): Customer[] {
  const best = new Map<string, { row: Customer; score: number }>();
  const out: Customer[] = [];
  for (const c of rows) {
    const id = c.workspace_id;
    if (!id) {
      out.push(c);
      continue;
    }
    const score = enrichmentScore(c);
    const existing = best.get(id);
    if (!existing || score > existing.score) {
      best.set(id, { row: c, score });
    }
  }
  // Emit in the original q10600 order to keep downstream sort
  // assumptions (e.g. "first match wins" in csm lookups) stable.
  const seen = new Set<string>();
  for (const c of rows) {
    if (!c.workspace_id) continue;
    if (seen.has(c.workspace_id)) continue;
    const pick = best.get(c.workspace_id);
    if (pick) {
      seen.add(c.workspace_id);
      out.push(pick.row);
    }
  }
  return out;
}

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
  raw = dedupeByWorkspace(raw);

  rawCache = { source, data: raw, expires: now + CACHE_TTL_MS };
  return raw;
}

export async function loadCustomers(): Promise<Customer[]> {
  // Demo mode short-circuit: never touch the real snapshot / Metabase
  // when DEMO_MODE=true. Returns the hand-built fixture book and
  // skips the override application (overrides are KV-backed and
  // shouldn't bleed in from real-data sessions). See
  // src/lib/demo/customer-fixture.ts.
  if (isDemoMode()) {
    return buildDemoCustomers(new Date());
  }
  const raw = await loadRawCustomers();
  const overrides = await loadOverrides();
  // Append the synthetic test workspace after overrides — it's not in the
  // Metabase snapshot, so applyOverride() would no-op on it anyway, and
  // keeping it outside the override loop guarantees its placeholder
  // values can't be accidentally mutated.
  return [...raw.map((c) => applyOverride(c, overrides)), TEST_CUSTOMER];
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

/**
 * Look up the internal CSM handle ("Jacob_Perry") owned by the
 * sign-in email. Walks the customer book for a row where
 * customer_success_manager_email matches; returns the
 * customer_success_manager on that row. Returns null when the
 * viewer isn't a CSM in the book (admin email, ex-employee, etc.).
 *
 * Used by the page-level CSM filter to auto-scope to the viewer's
 * own book on first load — they can opt out with the "All CSMs"
 * option in the dropdown (which writes ?csm=all to the URL).
 */
export function findCsmHandleForViewer(
  customers: Customer[],
  viewerEmail: string | null | undefined
): string | null {
  if (!viewerEmail) return null;
  const target = viewerEmail.toLowerCase();
  for (const c of customers) {
    const email = c.customer_success_manager_email;
    if (
      email &&
      email.toLowerCase() === target &&
      c.customer_success_manager
    ) {
      return c.customer_success_manager;
    }
  }
  return null;
}

/**
 * Resolve the effective CSM filter for a page given the raw URL
 * param + the signed-in viewer's email.
 *
 *   sp.csm undefined  → default to viewer's own CSM handle when
 *                       we can match them in the book; else null
 *                       (show everyone — better than showing nothing
 *                       to an admin who isn't a CSM).
 *   sp.csm === "all"  → null (explicit "show everyone" override).
 *   sp.csm specific   → that handle as-is.
 *
 * Returns null when no filter should be applied.
 */
export function resolveCsmFilter(
  raw: string | undefined,
  customers: Customer[],
  viewerEmail: string | null | undefined
): string | null {
  if (raw === "all") return null;
  // In demo mode, default to "show all" instead of scoping to the
  // viewer's CSM handle — every demo customer is owned by the same
  // synthetic Demo_User, so any real viewer would see an empty book
  // under the normal default-filter behavior.
  if (raw === undefined && isDemoMode()) return null;
  if (raw === undefined) {
    return findCsmHandleForViewer(customers, viewerEmail);
  }
  return raw || null;
}
