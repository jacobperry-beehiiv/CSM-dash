/**
 * @bot assign partial-state audit.
 *
 * Cross-references the customer book against per-CSM personal-todo
 * blobs and the HubSpot fields the assign flow writes, to enumerate
 * accounts whose @bot assign appears to have died mid-flight during
 * the 2026-06-23 → 2026-09-22 window where the view-submission
 * handler was blowing through Vercel's 15s serverless timeout. See
 * PR #254 for the async-dispatch fix; this engine is the audit trail.
 *
 * Read-only — never writes, never DMs. Feeds an /admin page that
 * lists the affected accounts so a CSM can decide per-row whether to
 *   • re-run @bot assign (safe now, post-#254 — todo dedupe stays
 *     idempotent, HubSpot writes are set-not-append)
 *   • run /api/lifecycle/backfill-onboarding for just the todos step,
 *   • run /settings/customer-folders sweep to fuzzy-match an
 *     orphaned Drive folder back to HubSpot's customer_folder prop.
 *
 * Four signals covering the four HubSpot fields the assign flow
 * writes, plus the todo batch:
 *
 *   1. `customer_success_manager` (step 1)              — the gate;
 *      if missing, no @bot run has happened at all, so we don't
 *      audit further (also skips manually-assigned rows that were
 *      never routed through @bot).
 *   2. `property_company_status` (step 1)               — "Live" /
 *      "Onboarding" / other. Any non-empty value counts: CSMs can
 *      legitimately change status later, so a downstream "Live"
 *      still proves step 1 landed.
 *   3. `property_risk_level` (step 1)                   — @bot writes
 *      "Light Green" but CSMs can adjust later. Any non-empty value
 *      counts, same reasoning as status.
 *   4. `property_customer_folder` (step 5)              — the Drive
 *      folder URL PATCH; missing means the second HubSpot PATCH
 *      never ran (usually implies Drive step 4/4b also failed).
 *   5. `slack_assign` open todo batch on the assigned CSM's list
 *      (step 3)                                         — dedupe-
 *      keyed on `source_meta.hubspot_company_id`.
 *
 * A row is included when the CSM is set (guard #1 passes) but any
 * of signals #2–#5 is missing. Rows sort by "most-broken first"
 * then newest reassignment.
 *
 * False positives — intentional; both cheap to dismiss on review:
 *   • Accounts reassigned manually in HubSpot (no @bot run) will
 *     have CSM set but no todos, no folder. That's fine — the
 *     backfill flow works for them too (that's what
 *     /api/lifecycle/backfill-onboarding was originally built for).
 *   • Accounts where the CSM cleared the todo batch after
 *     completion appear as "missing todos". Reduced by only
 *     counting OPEN todos, matching @bot's dedupe check.
 *   • Older assignments that legitimately never had a Drive folder
 *     (pre-2026-06-23) are filtered out via
 *     `property_csm_owner_change_date >= TEMPLATE_SEED_INTRODUCED_AT`.
 */

import { loadCustomers } from "../data/load-customers";
import { getTodosForUser } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import type { Customer } from "../types";

/** Date (inclusive) when template seeding first entered the @bot
 *  assign flow — PR #43, "Onboarding assign: pre-seed Drive folder
 *  from a template". Before this the flow ran in ~5s and fit under
 *  Vercel's 15s ceiling. Change-date filter uses this as the lower
 *  bound so pre-template-seed assignments (which weren't at risk)
 *  don't clutter the audit. */
export const TEMPLATE_SEED_INTRODUCED_AT = "2026-06-23";

/** One row per affected account. Boolean signals mirror the HubSpot
 *  fields the assign flow sets, plus the todo batch — see the class
 *  comment on this module for what each corresponds to in the flow.
 *  Observed values on the enum fields are carried through for the UI
 *  so a reviewer can see whether a status/risk was changed to a
 *  legitimate later value vs. empty. */
export interface AssignAuditRow {
  workspace_id: string;
  workspace_name: string;
  company_name: string | null;
  hubspot_company_id: string;
  csm_email: string;
  csm_owner_change_date: string | null;
  missing_status: boolean;
  missing_risk_level: boolean;
  missing_customer_folder: boolean;
  missing_todos: boolean;
  observed_status: string | null;
  observed_risk_level: string | null;
  /** How many of the four signals are missing (0-4). Drives the
   *  primary sort; higher = more work needed. */
  missing_count: number;
}

export interface AssignAuditReport {
  window_start: string;
  scanned_customers: number;
  scanned_csms: number;
  affected: AssignAuditRow[];
  totals: {
    total_affected: number;
    missing_status: number;
    missing_risk_level: number;
    missing_customer_folder: number;
    missing_todos: number;
  };
  ran_at: string;
}

function isEmpty(v: string | null | undefined): boolean {
  return !v || v.trim() === "";
}

export async function runAssignAudit(): Promise<AssignAuditReport> {
  const customers = await loadCustomers();

  // Bucket by assigned CSM so getTodosForUser runs once per CSM
  // instead of once per customer. The customer book has ~100
  // assigned rows but only ~10 CSMs, so this is a >10× read
  // reduction and keeps the audit fast enough for a live page render.
  const byCsm = new Map<string, Customer[]>();
  let scanned = 0;
  for (const c of customers) {
    scanned++;
    const csm = c.customer_success_manager_email?.trim().toLowerCase();
    if (!csm) continue;
    if (!c.hubspot_company_id) continue;
    if (!c.workspace_id) continue;

    // Scope to accounts reassigned during the affected window.
    // Accounts with no recorded change date fall through unchanged
    // — safer to over-audit than to miss a legitimately-broken
    // assignment because HubSpot's property-history didn't stamp a
    // date.
    const changeDate = (c.property_csm_owner_change_date ?? "").slice(0, 10);
    if (changeDate && changeDate < TEMPLATE_SEED_INTRODUCED_AT) continue;

    if (!byCsm.has(csm)) byCsm.set(csm, []);
    byCsm.get(csm)!.push(c);
  }

  const affected: AssignAuditRow[] = [];
  for (const [csm, list] of byCsm) {
    const todos = await getTodosForUser(userKeyFromEmail(csm));
    // Match @bot's own dedupe check: only OPEN batches count as
    // "todo sequence present". A completed batch shouldn't block a
    // recognition here — those todos existed and were worked, so
    // the assignment landed correctly.
    const assignBatchCompanies = new Set<string>();
    for (const t of todos) {
      if (t.source !== "slack_assign") continue;
      if (t.completed_at !== null) continue;
      const cid = t.source_meta?.hubspot_company_id;
      if (typeof cid === "string" && cid) assignBatchCompanies.add(cid);
    }
    for (const c of list) {
      const missing_todos = !assignBatchCompanies.has(c.hubspot_company_id!);
      const missing_status = isEmpty(c.property_company_status);
      const missing_risk_level = isEmpty(c.property_risk_level);
      const missing_customer_folder = isEmpty(c.property_customer_folder);
      const missing_count =
        (missing_todos ? 1 : 0) +
        (missing_status ? 1 : 0) +
        (missing_risk_level ? 1 : 0) +
        (missing_customer_folder ? 1 : 0);
      if (missing_count === 0) continue;
      affected.push({
        workspace_id: c.workspace_id!,
        workspace_name: c.workspace_name ?? "",
        company_name: c.company_name,
        hubspot_company_id: c.hubspot_company_id!,
        csm_email: csm,
        csm_owner_change_date: c.property_csm_owner_change_date ?? null,
        missing_status,
        missing_risk_level,
        missing_customer_folder,
        missing_todos,
        observed_status: c.property_company_status ?? null,
        observed_risk_level: c.property_risk_level ?? null,
        missing_count,
      });
    }
  }

  // Most-broken first (all four missing → likely never ran past
  // step 1), then newest reassignment date so today's live problems
  // sit above months-old edge cases.
  affected.sort((a, b) => {
    if (b.missing_count !== a.missing_count) {
      return b.missing_count - a.missing_count;
    }
    const ad = a.csm_owner_change_date ?? "";
    const bd = b.csm_owner_change_date ?? "";
    return bd.localeCompare(ad);
  });

  const totals = {
    total_affected: affected.length,
    missing_status: 0,
    missing_risk_level: 0,
    missing_customer_folder: 0,
    missing_todos: 0,
  };
  for (const row of affected) {
    if (row.missing_status) totals.missing_status++;
    if (row.missing_risk_level) totals.missing_risk_level++;
    if (row.missing_customer_folder) totals.missing_customer_folder++;
    if (row.missing_todos) totals.missing_todos++;
  }

  return {
    window_start: TEMPLATE_SEED_INTRODUCED_AT,
    scanned_customers: scanned,
    scanned_csms: byCsm.size,
    affected,
    totals,
    ran_at: new Date().toISOString(),
  };
}
