/**
 * @bot assign partial-state audit.
 *
 * Cross-references the customer book against per-CSM personal-todo
 * blobs and HubSpot's `customer_folder` property to enumerate
 * accounts whose @bot assign flow appears to have died mid-flight
 * during the 2026-06-23 → 2026-09-22 window where the view-submission
 * handler was blowing through Vercel's 15s serverless timeout. See
 * PR #254 for the async-dispatch fix; this engine is the audit trail.
 *
 * Read-only — never writes, never DMs. Feeds an /admin page that
 * lists the affected accounts so a CSM can decide per-row whether to
 *   • run the existing /api/lifecycle/backfill-onboarding endpoint
 *     to rebuild the missing to-do batch, and/or
 *   • run the /settings/customer-folders sweep to fuzzy-match an
 *     orphaned Drive folder back to HubSpot's customer_folder prop,
 *   • re-run @bot assign (now safe post-#254) as a full reset.
 *
 * Two signals — a row is included when either misses:
 *
 *   1. `slack_assign` batch on the assigned CSM's personal to-do
 *      list, keyed by `source_meta.hubspot_company_id` → the todos
 *      step of the assign flow.
 *   2. `customer_folder` property on the HubSpot company → the Drive
 *      folder creation + template-seed + property PATCH steps.
 *
 * False positives — the audit intentionally over-includes; both are
 * cheap to dismiss on review:
 *   • Accounts reassigned manually in HubSpot (no @bot run) will look
 *     like "no todos", correctly — the same backfill flow works for
 *     them too (that's what /api/lifecycle/backfill-onboarding was
 *     originally built for).
 *   • Accounts where a CSM cleared the todo batch after completion
 *     will look like "no todos" — filtered somewhat by only counting
 *     open todos (this engine matches @bot's own dedupe check).
 */

import { loadCustomers } from "../data/load-customers";
import { getTodosForUser } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import type { Customer } from "../types";

/** Date (inclusive) when template seeding first entered the @bot
 *  assign flow — PR #43, "Onboarding assign: pre-seed Drive folder
 *  from a template". Before this the flow ran in ~5s and fit under
 *  Vercel's 15s ceiling. Change-date filter uses this as the
 *  lower bound so pre-template-seed assignments (which weren't at
 *  risk) don't clutter the audit. */
export const TEMPLATE_SEED_INTRODUCED_AT = "2026-06-23";

/** Fingerprint of which step of the assign flow appears to have
 *  timed out. Not perfectly resolvable without Vercel logs, but the
 *  combination of "todos" + "customer_folder" signals lets us guess:
 *
 *    no_todos_no_folder            — timed out at or before step 3
 *                                    (todo creation); nothing after
 *                                    the HubSpot PATCH landed
 *    todos_present_folder_missing  — timed out at step 4/4b/5 (Drive
 *                                    folder create → template seed →
 *                                    HubSpot customer_folder PATCH);
 *                                    todos exist but the folder link
 *                                    doesn't. Also matches step 4/4b
 *                                    where the folder itself was
 *                                    never created, so this bucket
 *                                    is a superset.
 *    folder_present_todos_missing  — atypical: HubSpot property set
 *                                    but no todos. Suggests the todo
 *                                    write raced with a dedup, or a
 *                                    manual customer_folder edit
 *                                    happened without a @bot run.
 */
export type AssignAuditFingerprint =
  | "no_todos_no_folder"
  | "todos_present_folder_missing"
  | "folder_present_todos_missing";

export interface AssignAuditRow {
  workspace_id: string;
  workspace_name: string;
  company_name: string | null;
  hubspot_company_id: string;
  csm_email: string;
  csm_owner_change_date: string | null;
  missing_todos: boolean;
  missing_customer_folder: boolean;
  fingerprint: AssignAuditFingerprint;
}

export interface AssignAuditReport {
  window_start: string;
  scanned_customers: number;
  scanned_csms: number;
  affected: AssignAuditRow[];
  /** Totals per fingerprint for the summary card. */
  totals: Record<AssignAuditFingerprint, number>;
  /** ISO timestamp the audit ran. Used to stamp "as of" in the UI. */
  ran_at: string;
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

    // The CSM-owner-change-date filter scopes the audit to accounts
    // reassigned during the affected window. Accounts with no
    // recorded change date fall through unchanged — safer to over-
    // audit than to miss a legitimately-broken assignment because
    // HubSpot's property-history didn't stamp a date.
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
      const hasTodos = assignBatchCompanies.has(c.hubspot_company_id!);
      const hasFolder = Boolean(c.property_customer_folder?.trim());
      if (hasTodos && hasFolder) continue;
      const fingerprint: AssignAuditFingerprint =
        !hasTodos && !hasFolder
          ? "no_todos_no_folder"
          : hasTodos && !hasFolder
            ? "todos_present_folder_missing"
            : "folder_present_todos_missing";
      affected.push({
        workspace_id: c.workspace_id!,
        workspace_name: c.workspace_name ?? "",
        company_name: c.company_name,
        hubspot_company_id: c.hubspot_company_id!,
        csm_email: csm,
        csm_owner_change_date: c.property_csm_owner_change_date ?? null,
        missing_todos: !hasTodos,
        missing_customer_folder: !hasFolder,
        fingerprint,
      });
    }
  }

  // Newest reassignment first so a reviewer sees today's broken
  // flows at the top; older cases sink to the bottom where they're
  // likely already worked around.
  affected.sort((a, b) => {
    const ad = a.csm_owner_change_date ?? "";
    const bd = b.csm_owner_change_date ?? "";
    return bd.localeCompare(ad);
  });

  const totals: Record<AssignAuditFingerprint, number> = {
    no_todos_no_folder: 0,
    todos_present_folder_missing: 0,
    folder_present_todos_missing: 0,
  };
  for (const row of affected) totals[row.fingerprint]++;

  return {
    window_start: TEMPLATE_SEED_INTRODUCED_AT,
    scanned_customers: scanned,
    scanned_csms: byCsm.size,
    affected,
    totals,
    ran_at: new Date().toISOString(),
  };
}
