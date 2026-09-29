import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import {
  loadEnterpriseRequestsSnapshot,
  loadNotifiedOverlay,
} from "@/lib/data/enterprise-requests";
import {
  hasDevsShippedMatch,
  isLive,
  lastEngagedAt,
  liveAt,
  resolveConfidence,
} from "@/lib/data/enterprise-requests-types";
import type {
  CustomerImpactLabel,
  EnterpriseRequestDerivedState,
  EnterpriseRequestRow,
  NeedsReviewReason,
  NotifiedEntry,
  PromotionConfidence,
  PromotionSource,
  WorkTypeLabel,
} from "@/lib/data/enterprise-requests-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/enterprise-requests/live-requests
 *
 * Shipped feature requests, grouped by Linear ticket rather than
 * fanned out per customer.
 *
 * The snapshot stores one row per (workspace_id, linear_issue_id) so
 * the customer-profile render is a straight lookup. That shape is
 * wrong for the question this endpoint answers — "what shipped
 * recently, and who was asking for it" — where a ticket wanted by
 * four accounts should read as one line with four customers, not
 * four lines. So we regroup here rather than at storage time; the
 * profile still gets its cheap lookup.
 *
 * Query params (all optional):
 *   csm      — handle or email to scope to. `all` widens to every
 *              account. Empty = the viewer's own book.
 *   window   — 7d | 30d | 90d | all   (default 30d)
 *   include_notified — "1" keeps rows the CSM already marked notified
 *   confidence — confirmed | all      (default confirmed)
 *
 * Scoping note: a ticket is INCLUDED when at least one attached
 * customer is in scope, but the group then lists EVERY attached
 * customer — including accounts belonging to other CSMs. Knowing a
 * fix you're about to tell a customer about also landed for three
 * other accounts is useful context, and hiding it would make the
 * customer count wrong. Out-of-scope customers come back with
 * `in_scope: false` so the UI can render them as context rather than
 * as action rows.
 *
 * Session-auth only; no admin gate.
 */

const WINDOW_MS: Record<string, number | null> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  all: null,
};

interface GroupCustomer {
  workspace_id: string;
  workspace_name: string | null;
  company_name: string | null;
  csm_handle: string | null;
  /** True when this customer sits inside the requested scope. The UI
   *  only offers Draft-outreach / Notified controls on these. */
  in_scope: boolean;
  notified: NotifiedEntry;
  arr_snapshot: number | null;
  customer_impact: CustomerImpactLabel | null;
  submitted_at: string | null;
  submitting_csm_email: string | null;
}

interface TicketGroup {
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  url: string;
  derived_state: EnterpriseRequestDerivedState;
  /** Linear's own state, carried alongside the derived bucket.
   *
   *  `linearStateToDerived` maps Linear `completed` to "In progress"
   *  on purpose — merged is not released, and only the shipped-sweep
   *  may promote to Live. Correct, but it means a genuinely-Done
   *  ticket renders as "In progress" until a Slack ship post is
   *  matched. In an inventory view that reads as a bug, so the raw
   *  state travels with the row and the UI shows both. */
  linear_state_name: string;
  linear_state_type: string;
  work_type: WorkTypeLabel | null;
  promotion_source: PromotionSource | null;
  promotion_confidence: PromotionConfidence;
  /** Yes/no: did a #devs-shipped release post carry this ticket? */
  devs_shipped_match: boolean;
  devs_shipped_url: string | null;
  devs_shipped_at: string | null;
  needs_review_reason: NeedsReviewReason | null;
  /** Set when a human cleared this row out of the exceptions queue.
   *  Lets the UI distinguish "confirmed by rule" from "a person
   *  vouched for this", which is a materially different level of
   *  assurance when you're about to email a customer. */
  reviewed_by: string | null;
  reviewed_at: string | null;
  ship_url: string | null;
  ship_date: string | null;
  /** Newest promoted_at across attached customers — the ship moment
   *  for the ticket as a whole. Drives sort + the window filter. */
  promoted_at: string | null;
  /** Newest engagement across every customer attached to this ticket —
   *  a need logged, a comment added, or the ship. What the list sorts
   *  by, so a months-old request that someone touched yesterday
   *  surfaces instead of sinking. */
  last_engaged_at: string | null;
  customers: GroupCustomer[];
  customer_count: number;
  /** How many attached customers sit in the requested scope. Lets the
   *  UI say "2 of 5 accounts are yours" without re-counting. */
  in_scope_count: number;
  /** Sum of arr_snapshot across attached customers. Cheap proxy for
   *  "how much did this ship matter" when triaging a long list. */
  total_arr: number;
}

export async function GET(req: Request) {
  const session = await auth();
  const viewerEmail = session?.user?.email;
  if (!viewerEmail) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const url = new URL(req.url);
  const csmParam = (url.searchParams.get("csm") ?? "").trim().toLowerCase();
  const includeNotified = url.searchParams.get("include_notified") === "1";
  const windowKey = url.searchParams.get("window") ?? "30d";
  const windowMs = windowKey in WINDOW_MS ? WINDOW_MS[windowKey] : WINDOW_MS["30d"];
  // Default flipped from "confirmed" to "all" with the move to
  // Linear-owned state. It used to mean "only rows Slack corroborated",
  // which in practice hid nearly every delivered request and made this
  // tab look empty. Narrowing to ship-matched rows is now opt-in.
  const confidenceParam = url.searchParams.get("confidence") ?? "all";
  const confirmedOnly = confidenceParam === "confirmed";
  // mode=shipped (default) — the outreach queue: only rows the
  // shipped-sweep promoted, inside a recency window.
  // mode=all — the book's whole request inventory regardless of
  // whether anything shipped, which is the question "what has my book
  // asked for, and where does it stand?". Same grouping and customer
  // attachment either way; only the row filter differs.
  const mode = url.searchParams.get("mode") === "all" ? "all" : "shipped";
  // Comma-separated derived_state values. Only meaningful in `all`
  // mode — in shipped mode the promotion filter already implies it.
  const stateParam = (url.searchParams.get("states") ?? "").trim();
  const wantedStates = new Set(
    stateParam ? stateParam.split(",").map((s) => s.trim()).filter(Boolean) : []
  );

  const [customers, snapshot, notified] = await Promise.all([
    loadCustomers(),
    loadEnterpriseRequestsSnapshot(),
    loadNotifiedOverlay(),
  ]);

  const wantAll = csmParam === "all";
  const targetEmail = csmParam.includes("@")
    ? csmParam
    : viewerEmail.toLowerCase();
  const targetHandle =
    !wantAll && csmParam && !csmParam.includes("@") ? csmParam : null;

  // Every workspace in the book, plus a flag for whether it's in the
  // requested scope. We need the full map (not just the scoped set)
  // so a group can name out-of-scope customers attached to the same
  // ticket.
  interface WsMeta {
    workspace_name: string | null;
    company_name: string | null;
    csm_handle: string | null;
    in_scope: boolean;
  }
  const wsMeta = new Map<string, WsMeta>();
  for (const c of customers) {
    if (!c.workspace_id) continue;
    const email = (c.customer_success_manager_email ?? "").toLowerCase();
    const handle = (c.customer_success_manager ?? "")
      .replace(/\s+/g, "_")
      .toLowerCase();
    const inScope = wantAll
      ? true
      : targetHandle
        ? handle === targetHandle
        : email === targetEmail;
    wsMeta.set(c.workspace_id, {
      workspace_name: c.workspace_name ?? null,
      company_name: c.company_name ?? null,
      csm_handle: c.customer_success_manager ?? null,
      in_scope: inScope,
    });
  }

  const cutoff = windowMs === null ? null : Date.now() - windowMs;

  // Pass 1 — walk every (workspace, issue) row, keeping the ones that
  // pass the ship/window/confidence filters, bucketed by issue.
  const byIssue = new Map<
    string,
    { rows: Array<{ workspaceId: string; row: EnterpriseRequestRow }> }
  >();
  for (const [workspaceId, bucket] of Object.entries(snapshot.rows)) {
    for (const row of Object.values(bucket) as EnterpriseRequestRow[]) {
      if (mode === "shipped") {
        // "Shipped" is now Linear's call, not Slack's: the row is in
        // the state whose Linear name is "Done (live in app)". The
        // window runs off when it entered that state.
        if (!isLive(row)) continue;
        const wentLive = liveAt(row);
        if (!wentLive) continue;
        const liveMs = Date.parse(wentLive);
        if (!Number.isFinite(liveMs)) continue;
        if (cutoff !== null && liveMs < cutoff) continue;
        // `confirmed` now means "we also found a #devs-shipped post
        // carrying this ticket". Opt-in filter, not a default gate —
        // gating on it by default is what made this tab look empty.
        if (confirmedOnly && !hasDevsShippedMatch(row)) continue;
      } else {
        // `all` mode ignores promotion entirely — an Open request that
        // has never shipped is exactly what this view exists to show.
        // The window still applies when one is set, but against the
        // request's SUBMISSION date rather than a ship it may never
        // have had.
        if (wantedStates.size > 0 && !wantedStates.has(row.derived_state)) {
          continue;
        }
        if (cutoff !== null) {
          const submitted = Date.parse(row.submitted_at ?? "");
          if (Number.isFinite(submitted) && submitted < cutoff) continue;
        }
      }
      // A dismissed review means we decided this isn't a real
      // customer-visible ship — it shouldn't show up as one.
      if (row.review?.decision === "dismissed") continue;
      const entry = byIssue.get(row.linear_issue_id) ?? { rows: [] };
      entry.rows.push({ workspaceId, row });
      byIssue.set(row.linear_issue_id, entry);
    }
  }

  // Pass 2 — build groups, dropping any ticket with no in-scope
  // customer, and applying the notified filter per customer.
  const groups: TicketGroup[] = [];
  for (const [issueId, { rows }] of byIssue) {
    const groupCustomers: GroupCustomer[] = [];
    let inScopeCount = 0;
    let totalArr = 0;
    let newestPromotedAt: string | null = null;
    let newestEngagedAt: string | null = null;
    // Representative row for the ticket-level fields. Every row for
    // the same issue carries identical Linear metadata (the fan-out
    // only varies the customer side), so the first is as good as any
    // — except for promoted_at, which we max across rows below.
    const head = rows[0].row;

    for (const { workspaceId, row } of rows) {
      const meta = wsMeta.get(workspaceId);
      const notifiedBucket = notified.rows[workspaceId] ?? {};
      const entry = notifiedBucket[issueId] ?? {};
      const inScope = meta?.in_scope ?? false;
      if (inScope) {
        // The notified filter only prunes in-scope customers — an
        // out-of-scope account is context, and hiding it because
        // someone else's CSM already did their outreach would make
        // the customer count misleading.
        if (entry.notified_at && !includeNotified) continue;
        inScopeCount += 1;
      }
      totalArr += row.arr_snapshot ?? 0;
      const rowLiveAt = liveAt(row);
      if (!newestPromotedAt || (rowLiveAt ?? "") > newestPromotedAt) {
        newestPromotedAt = rowLiveAt;
      }
      const rowEngagedAt = row.last_engaged_at ?? lastEngagedAt(row);
      if (rowEngagedAt && (!newestEngagedAt || rowEngagedAt > newestEngagedAt)) {
        newestEngagedAt = rowEngagedAt;
      }
      groupCustomers.push({
        workspace_id: workspaceId,
        workspace_name: meta?.workspace_name ?? null,
        company_name: meta?.company_name ?? null,
        csm_handle: meta?.csm_handle ?? null,
        in_scope: inScope,
        notified: entry,
        arr_snapshot: row.arr_snapshot,
        customer_impact: row.customer_impact,
        submitted_at: row.submitted_at ?? null,
        submitting_csm_email: row.submitting_csm_email,
      });
    }

    if (inScopeCount === 0) continue;

    // Biggest-ARR customer first inside the group, in-scope ahead of
    // context rows.
    groupCustomers.sort((a, b) => {
      if (a.in_scope !== b.in_scope) return a.in_scope ? -1 : 1;
      return (b.arr_snapshot ?? 0) - (a.arr_snapshot ?? 0);
    });

    groups.push({
      linear_issue_id: issueId,
      linear_identifier: head.linear_identifier,
      title: head.title,
      url: head.url,
      derived_state: head.derived_state,
      linear_state_name: head.linear_state_name,
      linear_state_type: head.linear_state_type,
      work_type: head.work_type,
      promotion_source: head.promotion_source,
      promotion_confidence: resolveConfidence(head),
      devs_shipped_match: hasDevsShippedMatch(head),
      devs_shipped_url: head.devs_shipped_url ?? null,
      devs_shipped_at: head.devs_shipped_at ?? null,
      needs_review_reason: head.needs_review_reason ?? null,
      reviewed_by:
        head.review?.decision === "confirmed"
          ? head.review.decided_by
          : null,
      reviewed_at:
        head.review?.decision === "confirmed" ? head.review.decided_at : null,
      ship_url: head.ship_url,
      ship_date: head.ship_date,
      promoted_at: newestPromotedAt,
      last_engaged_at: newestEngagedAt,
      customers: groupCustomers,
      customer_count: groupCustomers.length,
      in_scope_count: inScopeCount,
      total_arr: totalArr,
    });
  }

  // Most recently engaged first.
  //
  // Was "newest ship, falling back to newest submission", which buried
  // exactly the rows worth seeing: a request filed in March that a CSM
  // attached a new customer to last week sorted by March. Engagement
  // folds the ship date, the submission dates and any comment activity
  // into one key, so recency means recency.
  groups.sort((a, b) => {
    const key = (g: TicketGroup) =>
      g.last_engaged_at ??
      g.promoted_at ??
      g.customers.reduce<string>(
        (max, c) => ((c.submitted_at ?? "") > max ? c.submitted_at ?? "" : max),
        ""
      );
    return key(b).localeCompare(key(a));
  });

  return NextResponse.json({
    csm: wantAll ? "all" : csmParam || viewerEmail.toLowerCase(),
    mode,
    window: windowKey in WINDOW_MS ? windowKey : "30d",
    confidence: confirmedOnly ? "confirmed" : "all",
    groups,
    count: groups.length,
    /** Total distinct (ticket, customer) pairs in scope — the number
     *  of outreach conversations these groups represent. */
    in_scope_pairs: groups.reduce((n, g) => n + g.in_scope_count, 0),
    last_synced_at: snapshot.fetched_at,
  });
}
