import { Suspense } from "react";
import {
  isEnterprise,
  loadCustomers,
  uniqueCsms,
} from "@/lib/data/load-customers";
import {
  loadApproachingEnterprise,
  loadPastDue,
} from "@/lib/engines/am-cohorts";
import type { Customer } from "@/lib/types";

import { TabBar } from "@/components/tab-bar";
import { EnterpriseOnlyPanel } from "@/components/am/enterprise-only-panel";
import { ApproachingEnterprisePanel } from "@/components/am/approaching-enterprise-panel";
import { PastDuePanel } from "@/components/am/past-due-panel";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TABS = [
  { id: "enterprise", label: "Enterprise Only" },
  { id: "approaching", label: "Approaching Enterprise" },
  { id: "past-due", label: "Past Due" },
];

const ENT_UTIL_THRESHOLD = 0.85;

interface SP {
  tab?: string;
  csm?: string;
}

function utilPct(c: Customer): number | null {
  if (c.percent_of_max_subs != null) {
    return c.percent_of_max_subs > 1
      ? c.percent_of_max_subs / 100
      : c.percent_of_max_subs;
  }
  if (c.active_subs != null && c.max_subscriptions) {
    return c.active_subs / c.max_subscriptions;
  }
  return null;
}

async function ApproachingTab() {
  try {
    const rows = await loadApproachingEnterprise();
    return <ApproachingEnterprisePanel rows={rows} />;
  } catch (e) {
    return (
      <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 text-sm text-red-800 dark:text-red-300">
        Approaching-Enterprise feed (q13268) failed:{" "}
        {e instanceof Error ? e.message : "unknown"}
      </div>
    );
  }
}

async function PastDueTab({
  csms,
  csm,
}: {
  csms: string[];
  csm: string | null;
}) {
  try {
    const allRows = await loadPastDue();
    // Server-side CSM filter so a URL change (?csm=Foo) forces a single
    // consistent re-render with the new rows prop. Doing this client-side
    // off useSearchParams left a window where the headline count
    // updated but the bucketed table body still rendered the previous
    // list — visible as 1-account-but-8-rows artefacting in screenshots.
    const rows = csm
      ? allRows.filter((r) => r.customer_success_manager === csm)
      : allRows;
    return (
      <PastDuePanel
        rows={rows}
        csms={csms}
        totalSourceRows={allRows.length}
      />
    );
  } catch (e) {
    return (
      <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 text-sm text-red-800 dark:text-red-300">
        Past-Due feed (q24620) failed:{" "}
        {e instanceof Error ? e.message : "unknown"}
      </div>
    );
  }
}

export default async function AmPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const tab = sp.tab ?? "enterprise";
  const csm = sp.csm ?? null;

  let body;
  let csms: string[] = [];

  try {
    const all = await loadCustomers();
    csms = uniqueCsms(all);

    if (tab === "enterprise") {
      const cohort = all
        .filter(isEnterprise)
        .filter((c) => {
          const u = utilPct(c);
          return u != null && u >= ENT_UTIL_THRESHOLD;
        })
        .filter((c) => !csm || c.customer_success_manager === csm);
      body = <EnterpriseOnlyPanel rows={cohort} csms={csms} />;
    } else if (tab === "approaching") {
      body = (
        <Suspense
          fallback={
            <div className="text-sm text-muted">
              Loading from Metabase q13268…
            </div>
          }
        >
          <ApproachingTab />
        </Suspense>
      );
    } else if (tab === "past-due") {
      body = (
        <Suspense
          fallback={
            <div className="text-sm text-muted">
              Loading from Metabase q24620…
            </div>
          }
        >
          <PastDueTab csms={csms} csm={csm} />
        </Suspense>
      );
    } else {
      body = <div className="text-sm text-muted">Unknown tab: {tab}</div>;
    }
  } catch (e) {
    body = (
      <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 text-sm text-red-800 dark:text-red-300">
        Failed to load: {e instanceof Error ? e.message : "Unknown"}
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-fg tracking-tight">AM dashboard</h1>
        <p className="text-sm text-muted mt-1">
          Three account cohorts that need an AM touch — Enterprise customers
          near their cap, Growth customers approaching the Enterprise threshold,
          and any past-due account regardless of plan.
        </p>
      </div>

      <TabBar tabs={TABS} defaultTab="enterprise" />
      {body}
    </>
  );
}
