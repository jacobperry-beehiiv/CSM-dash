import { Suspense } from "react";
import {
  filterCustomers,
  getDataSource,
  loadCustomers,
  uniqueCsms,
} from "@/lib/data/load-customers";
import { runAtRiskCheck } from "@/lib/engines/at-risk";
import { runDeliverabilityCheck } from "@/lib/engines/deliverability";
import type { CustomerWithMetrics, Segment } from "@/lib/types";

import { TabBar } from "@/components/tab-bar";
import { CustomerTable } from "@/components/customer-table";
import { AtRiskTable } from "@/components/at-risk-table";
import { RenewalPanel } from "@/components/renewal-panel";
import { DeliverabilityPanel } from "@/components/deliverability-panel";
import { DeliverabilityBanner } from "@/components/deliverability-banner";
import { DeliverabilityLoading } from "@/components/deliverability-loading";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TABS = [
  { id: "book", label: "All assigned" },
  { id: "deliverability", label: "Deliverability" },
  { id: "at-risk", label: "At-risk" },
  { id: "renewals", label: "Renewals" },
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
  // Legacy URLs may still link to ?tab=utilization. Feature/ad-network
  // filters now do that drill-down inside the consolidated book view.
  const rawTab = sp.tab ?? "book";
  const tab = rawTab === "utilization" ? "book" : rawTab;
  const csm = sp.csm ?? null;
  const segment: Segment = (sp.segment as Segment) ?? "enterprise";
  const source = getDataSource();

  let body;
  let error: string | null = null;
  let csms: string[] = [];

  try {
    const all = await loadCustomers();
    csms = uniqueCsms(all);
    const book = filterCustomers(all, { csm, segment });

    if (tab === "book") {
      const fullBook = filterCustomers(all, { csm }).map(withUtilization);
      body = <CustomerTable initialCustomers={fullBook} csms={csms} />;
    } else if (tab === "renewals") {
      body = <RenewalPanel customers={book} csms={csms} />;
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
