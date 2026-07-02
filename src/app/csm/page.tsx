import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  filterCustomers,
  getDataSource,
  loadCustomers,
  resolveCsmFilter,
  uniqueCsms,
} from "@/lib/data/load-customers";
import { auth } from "@/auth";
import { runAtRiskCheck } from "@/lib/engines/at-risk";
import { runDeliverabilityCheck } from "@/lib/engines/deliverability";
import type { CustomerWithMetrics, Segment } from "@/lib/types";

import { TabBar } from "@/components/tab-bar";
import { CustomerTable } from "@/components/customer-table";
import { AtRiskTable } from "@/components/at-risk-table";
import { DeliverabilityPanel } from "@/components/deliverability-panel";
import { DeliverabilityBanner } from "@/components/deliverability-banner";
import { DeliverabilityLoading } from "@/components/deliverability-loading";
import { QbrChartsTab } from "@/components/qbr-charts/qbr-charts-tab";
import type { WorkspaceOption } from "@/components/qbr-charts/workspace-picker";
import { WinsList } from "@/components/wins-list";
import { isAdmin } from "@/lib/auth/admin";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadWinsBlob } from "@/lib/data/wins-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BASE_TABS = [
  { id: "book", label: "All assigned" },
  { id: "deliverability", label: "Deliverability" },
  { id: "at-risk", label: "At-risk" },
  { id: "qbr-charts", label: "QBR Charts" },
];

interface SP {
  tab?: string;
  csm?: string;
  segment?: Segment;
}

function withUtilization(c: import("@/lib/types").Customer): CustomerWithMetrics {
  return {
    ...c,
    utilization_pct:
      c.active_subs != null && c.max_subscriptions
        ? (c.active_subs / c.max_subscriptions) * 100
        : c.percent_of_max_subs ?? null,
  };
}

async function DeliverabilityTab({
  csm,
  csms,
}: {
  csm: string | null;
  csms: string[];
}) {
  try {
    const result = await runDeliverabilityCheck({ csmName: csm });
    return <DeliverabilityPanel initial={result} csms={csms} />;
  } catch (e) {
    return (
      <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 text-sm text-red-800 dark:text-red-300">
        Live deliverability run failed:{" "}
        {e instanceof Error ? e.message : "unknown"}
      </div>
    );
  }
}

export default async function CsmPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  // Renewals moved to /am — redirect with the existing CSM filter so
  // bookmarks land at the same data. Preserves ?csm= so deep-links
  // to a specific CSM's renewal list keep working.
  if (sp.tab === "renewals") {
    const params = new URLSearchParams({ tab: "renewals" });
    if (sp.csm) params.set("csm", sp.csm);
    redirect(`/am?${params.toString()}`);
  }
  // Legacy URLs may still link to ?tab=utilization. Feature/ad-network
  // filters now do that drill-down inside the consolidated book view.
  const rawTab = sp.tab ?? "book";
  const tab = rawTab === "utilization" ? "book" : rawTab;
  const segment: Segment = (sp.segment as Segment) ?? "enterprise";
  const source = getDataSource();

  let body;
  let error: string | null = null;
  let csms: string[] = [];
  // Effective CSM filter: defaults to the viewer's own handle on
  // first load (?csm= absent), null when they pick "All CSMs"
  // (?csm=all). See lib/data/load-customers.ts → resolveCsmFilter.
  let csm: string | null = null;
  const session = await auth();
  const viewerEmail = session?.user?.email ?? null;
  // Wins tab is flag-gated so the daily detection cron isn't wasted
  // for CSMs who can't see the surface. Compute up-front so both the
  // tab strip and the tab body branch off the same value.
  const winsEnabled = await isFeatureEnabledFor(
    "wins-opportunities",
    viewerEmail
  );
  const TABS = winsEnabled
    ? [...BASE_TABS, { id: "wins", label: "Wins & Opportunities" }]
    : BASE_TABS;

  try {
    const all = await loadCustomers();
    csms = uniqueCsms(all);
    csm = resolveCsmFilter(sp.csm, all, viewerEmail);
    const book = filterCustomers(all, { csm, segment });

    if (tab === "book") {
      const fullBook = filterCustomers(all, { csm }).map(withUtilization);
      body = <CustomerTable initialCustomers={fullBook} csms={csms} />;
    } else if (tab === "at-risk") {
      const result = await runAtRiskCheck({ customers: book, csmName: null });
      body = <AtRiskTable data={result} csms={csms} />;
    } else if (tab === "deliverability") {
      const canRunLive = source === "metabase" || source === "snapshot";
      body = canRunLive ? (
        <Suspense fallback={<DeliverabilityLoading />}>
          <DeliverabilityTab csm={csm} csms={csms} />
        </Suspense>
      ) : (
        <DeliverabilityBanner source={source} />
      );
    } else if (tab === "qbr-charts") {
      // Workspace dropdown defaults to the viewer's CSM scope; admins
      // get a "show all" toggle. Pass the deduped book + admin flag —
      // /api/qbr-charts/chart-spec runs on demand from the client.
      const admin = isAdmin(viewerEmail);
      const wsOptions: WorkspaceOption[] = [];
      const seen = new Set<string>();
      for (const c of all) {
        if (!c.workspace_id || seen.has(c.workspace_id)) continue;
        seen.add(c.workspace_id);
        wsOptions.push({
          workspace_id: c.workspace_id,
          workspace_name: c.workspace_name,
          customer_success_manager: c.customer_success_manager,
        });
      }
      body = (
        <QbrChartsTab
          workspaces={wsOptions}
          csm={csm}
          isAdmin={admin}
        />
      );
    } else if (tab === "wins") {
      if (!winsEnabled) {
        body = (
          <div className="text-sm text-muted italic">
            Wins & Opportunities isn&apos;t enabled for this account yet.
          </div>
        );
      } else {
        const blob = await loadWinsBlob();
        body = (
          <WinsList
            blob={blob}
            csmName={csm}
            isAdmin={isAdmin(viewerEmail)}
          />
        );
      }
    } else {
      body = (
        <div className="text-sm text-muted">Unknown tab: {tab}</div>
      );
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-fg tracking-tight">CSM dashboard</h1>
        <p className="text-sm text-muted mt-1">
          {tab === "book"
            ? "Full assigned book — Enterprise + Growth"
            : "Enterprise book of business"}{" "}
          · live data from{" "}
          <code className="bg-surface-2 px-1 py-0.5 rounded">{source}</code>
          {csm ? <> · CSM: <strong>{csm.replace(/_/g, " ")}</strong></> : null}
        </p>
      </div>

      <TabBar tabs={TABS} defaultTab="book" />

      {error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-300 font-medium">Failed to load data</p>
          <p className="text-red-600 text-sm mt-1">{error}</p>
        </div>
      ) : (
        body
      )}
    </>
  );
}
