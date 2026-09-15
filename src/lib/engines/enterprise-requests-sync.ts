import { loadCustomers } from "../data/load-customers";
import { customerEmailSignals } from "../data/customer-domains";
import {
  loadEnterpriseRequestsSnapshot,
  loadManualMap,
  saveEnterpriseRequestsSnapshot,
} from "../data/enterprise-requests";
import type {
  CustomerImpactLabel,
  EnterpriseRequestRow,
  EnterpriseRequestsBlob,
  UnmatchedNeed,
  WorkTypeLabel,
} from "../data/enterprise-requests-types";
import { linearStateToDerived } from "../data/enterprise-requests-types";
import {
  fetchAllIssuesWithCustomerNeeds,
  type LinearCustomer,
  type LinearCustomerNeed,
  type LinearIssue,
} from "../integrations/linear";
import type { Customer } from "../types";

/**
 * Nightly Linear sync — pulls every issue with ≥1 customer_need,
 * matches each need's Linear customer to a dash workspace via a
 * three-strike fall-through (manual map → externalIds → domain
 * fallback), and writes the whole snapshot to KV under
 * `csm:enterprise-requests:v1`.
 *
 * Consumers (customer profile Requests section, /csm live-this-week
 * queue tab, filter chip) read the snapshot; nothing else calls
 * Linear at request time.
 *
 * The sweep clobbers `rows` and `unmatched` each run — this is a
 * pull-based, deterministic snapshot. The shipped-detection engine
 * (separate sweep) re-runs afterwards and re-applies its promotions,
 * so anything it touched isn't lost when the Linear state drifts.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Constant markers used inside the manual map to represent an
 *  admin's explicit "this Linear customer has no dash equivalent"
 *  decision. Distinct from an absent entry (unmatched) so the sync
 *  drops it from the queue on subsequent runs. */
const MANUAL_SKIPPED_MARKER = "__skipped";

export interface SyncResult {
  pulled: number;
  matched: number;
  unmatched: number;
  ok: boolean;
  fetched_at: string;
}

interface CustomerIndex {
  /** workspace_id → Customer */
  byWorkspace: Map<string, Customer>;
  /** owner_email (lowercased) → Set<workspace_id> */
  byEmail: Map<string, Set<string>>;
  /** domain (lowercased) → Set<workspace_id> */
  byDomain: Map<string, Set<string>>;
}

function buildCustomerIndex(customers: Customer[]): CustomerIndex {
  const byWorkspace = new Map<string, Customer>();
  const byEmail = new Map<string, Set<string>>();
  const byDomain = new Map<string, Set<string>>();
  const push = (map: Map<string, Set<string>>, key: string, ws: string) => {
    const existing = map.get(key) ?? new Set<string>();
    existing.add(ws);
    map.set(key, existing);
  };
  for (const c of customers) {
    if (!c.workspace_id) continue;
    byWorkspace.set(c.workspace_id, c);
    const signals = customerEmailSignals(c);
    for (const email of signals.emails) push(byEmail, email, c.workspace_id);
    for (const domain of signals.domains) push(byDomain, domain, c.workspace_id);
  }
  return { byWorkspace, byEmail, byDomain };
}

/** Try to resolve a Linear customer to a dash workspace_id. Returns
 *  the first match (deterministic when only one workspace matches;
 *  when multiple workspaces share a domain we grab the first — the
 *  admin queue is where an ambiguous case gets fixed). */
function matchLinearCustomer(
  linearCustomer: LinearCustomer,
  index: CustomerIndex,
  manualMap: Record<string, string>
): { workspaceId: string; source: "manual" | "external_id" | "email" | "domain" } | { skipped: true } | null {
  // 1. Admin-approved manual mapping — highest priority.
  const manual = manualMap[linearCustomer.id];
  if (manual === MANUAL_SKIPPED_MARKER) return { skipped: true };
  if (manual && index.byWorkspace.has(manual)) {
    return { workspaceId: manual, source: "manual" };
  }
  // 2. externalIds → workspace_id (UUID) or owner_email.
  for (const ext of linearCustomer.externalIds ?? []) {
    const trimmed = ext.trim();
    if (!trimmed) continue;
    if (UUID_RE.test(trimmed) && index.byWorkspace.has(trimmed)) {
      return { workspaceId: trimmed, source: "external_id" };
    }
    const lc = trimmed.toLowerCase();
    const emailHits = index.byEmail.get(lc);
    if (emailHits && emailHits.size > 0) {
      const first = emailHits.values().next().value;
      if (first) return { workspaceId: first, source: "email" };
    }
  }
  // 3. domains → any dash customer whose owner/contact domains
  //    intersect this Linear customer's domain list.
  for (const d of linearCustomer.domains ?? []) {
    const lc = d.trim().toLowerCase();
    if (!lc) continue;
    const domainHits = index.byDomain.get(lc);
    if (domainHits && domainHits.size > 0) {
      const first = domainHits.values().next().value;
      if (first) return { workspaceId: first, source: "domain" };
    }
  }
  return null;
}

const CUSTOMER_IMPACT_LABELS = new Set<CustomerImpactLabel>([
  "Churn Risk",
  "Blocking",
  "Friction",
  "Nice to have",
]);

const WORK_TYPE_LABELS = new Set<WorkTypeLabel>([
  "Bug",
  "Feature",
  "UI/UX Improvement",
]);

interface ExtractedLabels {
  work_type: WorkTypeLabel | null;
  customer_impact: CustomerImpactLabel | null;
  resurfaced: boolean;
}

function extractLabels(issue: LinearIssue): ExtractedLabels {
  let work_type: WorkTypeLabel | null = null;
  let customer_impact: CustomerImpactLabel | null = null;
  let resurfaced = false;
  for (const label of issue.labels?.nodes ?? []) {
    const name = label.name?.trim();
    if (!name) continue;
    if (CUSTOMER_IMPACT_LABELS.has(name as CustomerImpactLabel)) {
      customer_impact = name as CustomerImpactLabel;
    } else if (WORK_TYPE_LABELS.has(name as WorkTypeLabel)) {
      work_type = name as WorkTypeLabel;
    } else if (name === "Resurfaced") {
      resurfaced = true;
    }
  }
  return { work_type, customer_impact, resurfaced };
}

function buildRow(
  issue: LinearIssue,
  need: LinearCustomerNeed,
  workspaceId: string,
  arrSnapshot: number | null
): EnterpriseRequestRow {
  const labels = extractLabels(issue);
  return {
    linear_issue_id: issue.id,
    linear_identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    linear_state_name: issue.state?.name ?? "Unknown",
    linear_state_type: issue.state?.type ?? "unknown",
    derived_state: linearStateToDerived(issue.state?.type ?? "unknown"),
    work_type: labels.work_type,
    customer_impact: labels.customer_impact,
    resurfaced: labels.resurfaced,
    estimate: issue.estimate ?? null,
    project_name: issue.project?.name ?? null,
    project_url: issue.project?.url ?? null,
    project_status_type: issue.project?.status?.type ?? null,
    linear_completed_at: issue.completedAt ?? null,
    submitted_at: need.createdAt,
    submitting_csm_email: need.creator?.email ?? null,
    arr_snapshot: arrSnapshot,
    // Promotion metadata is left empty on sync; the shipped-detection
    // engine fills these in on its own sweep.
    promotion_source: null,
    promoted_at: null,
    ship_url: null,
    ship_date: null,
    promotion_history: [],
  };
}

/**
 * Run one sync pass. Idempotent — calling twice in a row produces
 * the same snapshot (barring Linear state drift between calls). Any
 * per-row Linear-facing error is caught and logged but doesn't abort
 * the run; the affected issue just falls off the snapshot until the
 * next sweep.
 */
export async function runEnterpriseRequestsSync(): Promise<SyncResult> {
  const [customers, manualMapBlob, prior] = await Promise.all([
    loadCustomers(),
    loadManualMap(),
    loadEnterpriseRequestsSnapshot(),
  ]);
  const index = buildCustomerIndex(customers);
  const manualMap = manualMapBlob.by_linear_customer_id;

  const issues = await fetchAllIssuesWithCustomerNeeds();
  const rows: EnterpriseRequestsBlob["rows"] = {};
  const unmatchedBy: Map<string, UnmatchedNeed> = new Map();
  let matched = 0;

  for (const issue of issues) {
    for (const need of issue.needs?.nodes ?? []) {
      const linearCustomer = need.customer;
      if (!linearCustomer) continue;
      const decision = matchLinearCustomer(linearCustomer, index, manualMap);
      if (!decision) {
        // Truly unmatched — surface in the admin queue.
        const key = `${linearCustomer.id}:${need.id}`;
        if (!unmatchedBy.has(key)) {
          unmatchedBy.set(key, {
            linear_customer_id: linearCustomer.id,
            linear_customer_name: linearCustomer.name,
            external_ids: linearCustomer.externalIds ?? [],
            domains: linearCustomer.domains ?? [],
            need_id: need.id,
            need_body: need.body ?? "",
            first_seen_at: need.createdAt,
          });
        }
        continue;
      }
      if ("skipped" in decision) continue; // Admin explicitly said "not a dash customer"
      const { workspaceId } = decision;
      matched += 1;
      // Preserve promotion metadata across sweeps by carrying it
      // forward from the prior snapshot. The shipped-sweep engine is
      // the sole promoter, but we don't run it back-to-back with the
      // Linear sync — carrying prevents a between-runs regression.
      const priorRow = prior.rows[workspaceId]?.[issue.id];
      const row = buildRow(issue, need, workspaceId, linearCustomer.revenue);
      if (priorRow) {
        row.promotion_source = priorRow.promotion_source;
        row.promoted_at = priorRow.promoted_at;
        row.ship_url = priorRow.ship_url;
        row.ship_date = priorRow.ship_date;
        row.promotion_history = priorRow.promotion_history;
        // Carry forward the slack-intake + linear-comment annotations.
        // These sweeps stamp additional context (Slack permalink,
        // Linear-comment permalink) on rows they can link to; a
        // customer_needs sync should never wipe that. Also preserve
        // intake_source posture: once a customer_need shows up in
        // Linear, this row is now dual-sourced — mark it as
        // customer_needs (the canonical path) but keep the annotation
        // blocks for the profile UI.
        row.slack_intake = priorRow.slack_intake ?? null;
        row.linear_comment = priorRow.linear_comment ?? null;
        row.pending_ship = priorRow.pending_ship ?? null;
        // If the shipped sweep had already promoted this row past
        // the Linear-native derived state, keep it. A Linear state
        // change (e.g. reopened for a follow-up) shouldn't demote
        // a shipped feature back to Open.
        if (
          priorRow.derived_state === "Live" ||
          priorRow.derived_state === "Live, possibly in beta"
        ) {
          row.derived_state = priorRow.derived_state;
        }
      }
      // Any row that flows out of the customer_needs sync is
      // canonically customer_needs, regardless of whether the
      // Slack-sweep discovered it first.
      row.intake_source = "customer_needs";
      const bucket = rows[workspaceId] ?? {};
      bucket[issue.id] = row;
      rows[workspaceId] = bucket;
    }
  }

  // ─── Deferred-promotion pass ────────────────────────────────────
  // The shipped-sweep captures a `pending_ship` block whenever a
  // Slack ship hit lands on a ticket whose parent project isn't
  // `completed` yet (e.g. BEE-24713 shipping under the still-in-
  // progress "Workspace Library" project). Now that we've refreshed
  // every row's `project_status_type` from Linear, walk every
  // pending row: if the project just crossed into `completed`,
  // apply the deferred promotion. This is the only path outside
  // the shipped-sweep that mutates `derived_state`.
  let deferred_applied = 0;
  for (const [workspaceId, bucket] of Object.entries(rows)) {
    for (const [issueId, row] of Object.entries(bucket)) {
      const pending = row.pending_ship;
      if (!pending) continue;
      if (row.project_status_type !== "completed") continue;
      // Never demote: if this row has already been promoted past
      // pending's target state, don't step backwards.
      if (
        (pending.target_state === "Live, possibly in beta" &&
          row.derived_state === "Live") ||
        row.derived_state === pending.target_state
      ) {
        bucket[issueId] = { ...row, pending_ship: null };
        continue;
      }
      const now = new Date().toISOString();
      bucket[issueId] = {
        ...row,
        derived_state: pending.target_state,
        promotion_source: pending.source,
        promoted_at: now,
        ship_url: pending.ship_url ?? row.ship_url,
        ship_date: pending.ship_date ?? row.ship_date,
        promotion_history: [
          ...(row.promotion_history ?? []),
          {
            from_state: row.derived_state,
            to_state: pending.target_state,
            source: pending.source,
            at: now,
            permalink: pending.ship_url,
          },
        ],
        pending_ship: null,
      };
      deferred_applied += 1;
    }
    rows[workspaceId] = bucket;
  }
  if (deferred_applied > 0) {
    console.log(
      `[enterprise-requests-sync] applied ${deferred_applied} deferred-project promotions`
    );
  }

  const fetched_at = new Date().toISOString();
  const unmatched = Array.from(unmatchedBy.values());
  const blob: EnterpriseRequestsBlob = {
    rows,
    unmatched,
    fetched_at,
    last_run: {
      pulled: issues.length,
      matched,
      unmatched: unmatched.length,
    },
  };
  await saveEnterpriseRequestsSnapshot(blob);
  return {
    pulled: issues.length,
    matched,
    unmatched: unmatched.length,
    ok: true,
    fetched_at,
  };
}
