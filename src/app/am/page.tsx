import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  isEnterprise,
  loadCustomers,
  resolveCsmFilter,
  uniqueCsms,
} from "@/lib/data/load-customers";
import { auth } from "@/auth";
import {
  loadApproachingEnterprise,
  loadPastDue,
  type ApproachingEntRow,
} from "@/lib/engines/am-cohorts";
import type { Customer } from "@/lib/types";

import { TabBar } from "@/components/tab-bar";
import { ProactiveOutreachPanel } from "@/components/am/proactive-outreach-panel";
import { PastDuePanel } from "@/components/am/past-due-panel";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Renewals moved back to /csm (CSMs own their renewals now — see
// PR #NNN). Old ?tab=renewals / ?tab=renewal-calendar bookmarks get
// redirected below.
const TABS = [
  { id: "proactive", label: "Proactive Outreach" },
  { id: "past-due", label: "Past Due" },
];

// Per the AM Hackathon brief follow-up: surface Enterprise accounts at
// ≥75% of cap so AM can start the upgrade conversation earlier in the
// curve, not just when the customer is already near hitting the limit.
const ENT_UTIL_THRESHOLD = 0.75;

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

async function ProactiveOutreachTab({
  enterpriseRows,
  csms,
  allCustomers,
  upgradeAnalysisEnabled,
  csm,
}: {
  enterpriseRows: Customer[];
  csms: string[];
  /** Full customer book — passed through to the D&C review queue
   *  under the Approaching Enterprise sub-tab so scan rows can join
   *  workspace_name / owner_email. Kept scoped to the viewer's csm
   *  filter downstream. */
  allCustomers: Customer[];
  upgradeAnalysisEnabled: boolean;
  csm: string | null;
}) {
  // Approaching-Enterprise rows come from Metabase q13268 — fetched
  // here in the server component so the panel renders against a
  // single, consistent snapshot.
  let approachingRows: ApproachingEntRow[] = [];
  let approachingError: string | null = null;
  try {
    approachingRows = await loadApproachingEnterprise();
  } catch (e) {
    approachingError = e instanceof Error ? e.message : "unknown";
  }
  return (
    <>
      {approachingError ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 text-sm text-red-800 dark:text-red-300 mb-4">
          Approaching-Enterprise feed (q13268) failed: {approachingError} —
          the &ldquo;Enterprise approaching cap&rdquo; sub-tab is unaffected.
        </div>
      ) : null}
      <ProactiveOutreachPanel
        enterpriseRows={enterpriseRows}
        approachingRows={approachingRows}
        csms={csms}
        allCustomers={allCustomers}
        upgradeAnalysisEnabled={upgradeAnalysisEnabled}
        csm={csm}
      />
    </>
  );
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
  // Renewals moved back to /csm as part of the CSM-owned renewals
  // rollout. Redirect old /am ?tab=renewals / renewal-calendar
  // bookmarks so they land at the new home, preserving ?csm=.
  if (sp.tab === "renewals" || sp.tab === "renewal-calendar") {
    const params = new URLSearchParams({ tab: sp.tab });
    if (sp.csm) params.set("csm", sp.csm);
    redirect(`/csm?${params.toString()}`);
  }
  // Back-compat for the legacy ?tab=enterprise / ?tab=approaching deep
  // links that pointed at the old separate top-level tabs. Redirect
  // them to the consolidated "proactive" pillar with the appropriate
  // sub-tab preselected so old bookmarks land where users expected.
  if (sp.tab === "enterprise" || sp.tab === "approaching") {
    const params = new URLSearchParams();
    params.set("tab", "proactive");
    params.set("potab", sp.tab);
    if (sp.csm) params.set("csm", sp.csm);
    redirect(`/am?${params.toString()}`);
  }
  const tab = sp.tab ?? "proactive";

  let body;
  let csms: string[] = [];
  // Effective CSM filter — defaults to the viewer's own handle on
  // first load; `?csm=all` is the explicit "show everyone" override.
  // See lib/data/load-customers.ts → resolveCsmFilter.
  let csm: string | null = null;

  try {
    const all = await loadCustomers();
    csms = uniqueCsms(all);
    const session = await auth();
    csm = resolveCsmFilter(sp.csm, all, session?.user?.email);
    // D&C Upgrade Analysis surfaces (row panel above expanded row
    // detail + review queue) live under the Approaching Enterprise
    // sub-tab. Not applicable to accounts that are already Enterprise,
    // so no wiring under the Enterprise-approaching-cap sub-tab.
    const upgradeAnalysisEnabled = await isFeatureEnabledFor(
      "upgrade-analysis",
      session?.user?.email ?? null
    );

    if (tab === "proactive") {
      // Enterprise cohort: customers near or over their sub cap. CSM
      // filter applies so a CSM-scoped view shows only their book.
      const enterpriseCohort = all
        .filter(isEnterprise)
        .filter((c) => {
          const u = utilPct(c);
          return u != null && u >= ENT_UTIL_THRESHOLD;
        })
        .filter((c) => !csm || c.customer_success_manager === csm);
      body = (
        <Suspense
          fallback={
            <div className="text-sm text-muted">
              Loading proactive cohorts…
            </div>
          }
        >
          <ProactiveOutreachTab
            enterpriseRows={enterpriseCohort}
            csms={csms}
            allCustomers={all}
            upgradeAnalysisEnabled={upgradeAnalysisEnabled}
            csm={csm}
          />
        </Suspense>
      );
    } else if (tab === "past-due") {
      // Past Due is the team-wide triage view — default to ALL CSMs
      // rather than auto-scoping to the viewer's own book. A CSM who
      // wants to filter to their own accounts can still pick their
      // handle from the dropdown; a deep-link with ?csm= still wins.
      const pastDueCsm =
        sp.csm && sp.csm !== "all" ? sp.csm : null;
      body = (
        <Suspense
          fallback={
            <div className="text-sm text-muted">
              Loading from Metabase q24620…
            </div>
          }
        >
          <PastDueTab csms={csms} csm={pastDueCsm} />
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

      <TabBar tabs={TABS} defaultTab="proactive" />
      {body}
    </>
  );
}
