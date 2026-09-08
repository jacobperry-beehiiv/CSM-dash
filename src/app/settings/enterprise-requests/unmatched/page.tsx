import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadCustomers } from "@/lib/data/load-customers";
import {
  loadEnterpriseRequestsSnapshot,
  loadManualMap,
} from "@/lib/data/enterprise-requests";
import { UnmatchedReview } from "@/components/enterprise-requests/unmatched-review";

export const dynamic = "force-dynamic";

/**
 * /settings/enterprise-requests/unmatched — admin queue for Linear
 * customers the nightly sync couldn't map to a dash workspace.
 *
 * For each row: Approve (pick a workspace_id) or Skip (mark this
 * Linear customer as intentionally unmapped so it stops appearing).
 * Manual mappings write to a tiny KV blob that the sync engine's
 * matcher consults FIRST on subsequent runs, before the three-strike
 * externalIds/domains fall-through — so an approval is durable and
 * survives Linear-side edits.
 */
export default async function EnterpriseRequestsUnmatchedPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("enterprise-requests", email))) {
    notFound();
  }

  const [snapshot, manualMap, customers] = await Promise.all([
    loadEnterpriseRequestsSnapshot(),
    loadManualMap(),
    loadCustomers(),
  ]);
  const workspaceOptions = customers
    .filter((c): c is typeof c & { workspace_id: string } =>
      Boolean(c.workspace_id)
    )
    .map((c) => ({
      workspace_id: c.workspace_id,
      label:
        c.company_name ??
        c.workspace_name ??
        c.owner_email ??
        c.workspace_id,
      csm: c.customer_success_manager ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Enterprise Request Loop — unmatched Linear customers
      </h1>
      <p className="text-sm text-muted mb-4 max-w-prose">
        Linear customers that the nightly sync couldn&rsquo;t map to a dash
        workspace via <code className="font-mono text-xs">externalIds</code>
        {" "}or shared email domains. Approve a match (picks the
        workspace) or Skip (drops from the queue on subsequent runs).
        Approvals are stored on their own KV blob so a re-sync
        doesn&rsquo;t clobber them.
      </p>
      <UnmatchedReview
        unmatched={snapshot.unmatched}
        manualMap={manualMap.by_linear_customer_id}
        workspaceOptions={workspaceOptions}
        lastSyncedAt={snapshot.fetched_at}
      />
    </div>
  );
}
