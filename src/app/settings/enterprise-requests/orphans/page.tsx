import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadOrphans } from "@/lib/data/enterprise-requests";
import { OrphansReview } from "@/components/enterprise-requests/orphans-review";

export const dynamic = "force-dynamic";

/**
 * /settings/enterprise-requests/orphans — admin queue for shipped-
 * channel hits (from #devs-shipped + #topic-product-changelog) that
 * couldn't be matched to any snapshot row within the 14-day grace
 * window. Typical causes: the linear.app/beehiiv/issue/<KEY> URL was
 * omitted from the release post; the changelog Feature Name didn't
 * fuzzy-match; or the Linear ticket was never opened.
 *
 * Actions per row:
 *   • Mark "not customer-facing" — permanently dismisses the row.
 *   • Leave pending — the default; the row stays in the queue and
 *     the sweep re-attempts to resolve it on subsequent runs.
 * The "manually pick a Linear key and stamp Live" action is
 * deliberately not wired yet — the sweep does not carry snapshot
 * context here and manual-mapping to a specific issue key needs a
 * secondary picker that isn't worth building for the ~1-per-week
 * volume we see in Piece 3.
 */
export default async function OrphansPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("enterprise-requests", email))) {
    notFound();
  }

  const blob = await loadOrphans();
  const orphans = Object.values(blob.orphans).sort((a, b) =>
    (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? "")
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Enterprise Request Loop — orphaned shipments
      </h1>
      <p className="text-sm text-muted mb-4 max-w-prose">
        Shipped-channel hits that never resolved to a snapshot row
        after 14 days. The shipped-sweep is conservative — a hit only
        promotes a row it can prove is a customer-requested feature.
        Everything else lands here for a human to eyeball.
      </p>
      <OrphansReview orphans={orphans} lastSyncedAt={blob.updated_at} />
    </div>
  );
}
