import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadEnterpriseRequestsSnapshot } from "@/lib/data/enterprise-requests";
import {
  hasDevsShippedMatch,
  isLive,
  liveAt,
} from "@/lib/data/enterprise-requests-types";
import type { EnterpriseRequestRow } from "@/lib/data/enterprise-requests-types";
import {
  ExceptionsReview,
  type ExceptionRow,
} from "@/components/enterprise-requests/exceptions-review";

export const dynamic = "force-dynamic";

/**
 * /settings/enterprise-requests/exceptions — reconciliation queue for
 * requests Linear calls live that no release post corroborates.
 *
 * The queue's meaning changed when Linear took ownership of state. It
 * used to hold ships we were WITHHOLDING from CSMs pending review, and
 * confirming a row is what released it. Nothing is withheld now —
 * every Linear-live request reaches its CSM, flagged if unmatched.
 *
 * What lands here is a mismatch worth a human eye: the Linear ticket
 * says Done (live in app), but we never found a #devs-shipped post
 * carrying it. Usually benign (shipped under a project ticket, or
 * before we started watching the channel); occasionally it means a
 * ticket was closed without the code going out.
 *
 * Distinct from the neighbouring orphans queue: orphans are ship posts
 * we couldn't match to ANY request — the mirror image of this.
 */
export default async function ExceptionsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("enterprise-requests", email))) {
    notFound();
  }

  const [snapshot, customers] = await Promise.all([
    loadEnterpriseRequestsSnapshot(),
    loadCustomers(),
  ]);

  const wsMeta = new Map(
    customers
      .filter((c): c is typeof c & { workspace_id: string } =>
        Boolean(c.workspace_id)
      )
      .map((c) => [
        c.workspace_id,
        {
          workspace_name: c.workspace_name ?? null,
          company_name: c.company_name ?? null,
          csm_handle: c.customer_success_manager ?? null,
        },
      ])
  );

  const rows: ExceptionRow[] = [];
  for (const [workspaceId, bucket] of Object.entries(snapshot.rows)) {
    for (const row of Object.values(bucket) as EnterpriseRequestRow[]) {
      // Linear says it's delivered...
      if (!isLive(row)) continue;
      // ...but no release post backs that up. Rows with a match need
      // no reconciling.
      if (hasDevsShippedMatch(row)) continue;
      // Already decided by a human — neither decision should reappear.
      if (row.review?.decision) continue;
      const meta = wsMeta.get(workspaceId);
      rows.push({
        workspace_id: workspaceId,
        workspace_name: meta?.workspace_name ?? null,
        company_name: meta?.company_name ?? null,
        csm_handle: meta?.csm_handle ?? null,
        linear_issue_id: row.linear_issue_id,
        linear_identifier: row.linear_identifier,
        title: row.title,
        url: row.url,
        work_type: row.work_type ?? null,
        reason: row.needs_review_reason ?? null,
        promotion_source: row.promotion_source ?? null,
        promoted_at: liveAt(row),
        ship_url: row.ship_url,
      });
    }
  }
  // Newest first — a request that just went live is the one whose
  // customer is most likely still waiting to hear.
  rows.sort((a, b) => (b.promoted_at ?? "").localeCompare(a.promoted_at ?? ""));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Enterprise Request Loop — needs review
      </h1>
      <p className="text-sm text-muted mb-4 max-w-prose">
        Requests Linear marks{" "}
        <code className="font-mono text-xs">Done (live in app)</code> where
        we found no matching release post in{" "}
        <code className="font-mono text-xs">#devs-shipped</code>. These{" "}
        <strong>do</strong> reach their CSM &mdash; flagged, not withheld.
        This queue exists so someone can reconcile them in a batch:
        confirm the ones that really did ship, dismiss the ones where
        the ticket was closed without the code going out.
      </p>
      <ExceptionsReview rows={rows} />
    </div>
  );
}
