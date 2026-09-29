import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  filterCustomers,
  loadCustomers,
  resolveCsmFilter,
  uniqueCsms,
} from "@/lib/data/load-customers";
import { CsmSelector } from "@/components/csm-selector";
import { AccountsWorkspace } from "@/components/accounts/accounts-workspace";

export const dynamic = "force-dynamic";

/**
 * /csm/accounts — the three-pane Accounts surface.
 *
 * A trial front door, running BESIDE the /csm tabs rather than
 * replacing them. The tabs it's meant to absorb (the book, At-risk,
 * Renewals, no-contact) become saved views over one list here; the
 * point of shipping it alongside is to find out which of those stop
 * getting opened before anything is deleted. Deleting them is the
 * actual goal — this is how we earn the right to.
 *
 * Its own page rather than a tenth tab: the layout is three panes with
 * their own scroll, and nesting that inside the tab strip would fight
 * the chrome it's proposing to remove.
 *
 * Scoped by the shared `?csm=` param so it agrees with every other
 * surface, and gated behind `accounts-view`.
 */
export default async function AccountsViewPage({
  searchParams,
}: {
  searchParams: Promise<{ csm?: string }>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const viewerEmail = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("accounts-view", viewerEmail))) {
    notFound();
  }

  // The Requests block and the "Open requests" view both need the
  // Enterprise Request Loop; resolved here so the client component
  // gets one boolean instead of doing its own gate check.
  const requestsEnabled = await isFeatureEnabledFor(
    "enterprise-requests",
    viewerEmail
  );

  const all = await loadCustomers();
  const csms = uniqueCsms(all);
  const csm = resolveCsmFilter(sp.csm, all, viewerEmail);
  const book = filterCustomers(all, { csm, segment: "enterprise" });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Accounts
          </h1>
          <p className="text-sm text-muted mt-0.5 max-w-prose">
            One list, filtered. The views on the left are the same book
            you see on the tabs — switching between them keeps your
            place and whichever account you had open.
          </p>
        </div>
        <CsmSelector csms={csms} />
      </div>

      <AccountsWorkspace
        customers={book}
        requestsEnabled={requestsEnabled}
      />

      <p className="text-[11px] text-muted">
        Trial surface, running alongside the existing tabs on purpose.
        If it works, the tabs it replaces get deleted — that&rsquo;s the
        point of it.
      </p>
    </div>
  );
}
