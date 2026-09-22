import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadEnterpriseRequestsSnapshot } from "@/lib/data/enterprise-requests";
import { resolveConfidence } from "@/lib/data/enterprise-requests-types";
import type { EnterpriseRequestRow } from "@/lib/data/enterprise-requests-types";
import {
  ExceptionsReview,
  type ExceptionRow,
} from "@/components/enterprise-requests/exceptions-review";

export const dynamic = "force-dynamic";

/**
 * /settings/enterprise-requests/exceptions — review queue for shipped
 * signals we matched to a customer but couldn't confidently classify.
 *
 * Distinct from the neighbouring orphans queue: orphans are ship
 * posts we couldn't match to ANY request. These are rows we DID
 * match, where the evidence isn't strong enough to tell a CSM to go
 * tell their customer. Confirming one makes it digest-eligible;
 * dismissing drops the Live badge off the customer profile.
 *
 * Nothing auto-confirms — a row sits here until a human decides. The
 * tradeoff is deliberate: late good news is recoverable, a premature
 * "your request shipped" is not.
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
      // Only rows the sweep actually promoted — an un-promoted row
      // has no ship signal to review.
      if (!row.promoted_at) continue;
      if (resolveConfidence(row) === "confirmed") continue;
      // Already decided by a human — confirmed rows flip confidence
      // (so they're filtered above), dismissed ones shouldn't
      // reappear in the queue.
      if (row.review?.decision === "dismissed") continue;
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
        promoted_at: row.promoted_at,
        ship_url: row.ship_url,
      });
    }
  }
  // Newest detection first — the freshest signals are the ones where
  // a CSM is most likely still waiting to hear something.
  rows.sort((a, b) => (b.promoted_at ?? "").localeCompare(a.promoted_at ?? ""));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Enterprise Request Loop — needs review
      </h1>
      <p className="text-sm text-muted mb-4 max-w-prose">
        Shipped signals we matched to a customer request but can&rsquo;t
        confidently call customer-visible. These never reach a
        CSM&rsquo;s DMs until someone confirms them here. Bug and UI/UX
        fixes seen in <code className="font-mono text-xs">#devs-shipped</code>{" "}
        clear automatically, as do exact changelog links &mdash;
        everything else lands in this queue.
      </p>
      <ExceptionsReview rows={rows} />
    </div>
  );
}
