import {
  filterCustomers,
  getDataSource,
  isEnterprise,
  loadCustomers,
  resolveCsmFilter,
} from "@/lib/data/load-customers";
import { auth } from "@/auth";
import { fmtCurrency } from "@/components/format";
import { TeamTasksPanel } from "@/components/team-tasks-panel";
import { PersonalTodosPanel } from "@/components/personal-todos-panel";
import { FeatureUpdatesPanel } from "@/components/feature-updates-panel";
import type { Customer, Segment } from "@/lib/types";

export const dynamic = "force-dynamic";

interface SP {
  csm?: string;
  segment?: Segment;
}

export default async function MissionControl({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const segment: Segment = (sp.segment as Segment) ?? "all";
  const source = getDataSource();

  let error: string | null = null;
  let book: Customer[] = [];
  let entCount = 0;
  let nonEntCount = 0;
  // Effective CSM filter resolved server-side from the URL + the
  // viewer's email. No ?csm= param → defaults to the viewer's own
  // CSM handle when we can match them; ?csm=all overrides to
  // everyone. `csm` is the value we filter the book by AND what we
  // surface in the subtitle text.
  let csm: string | null = null;

  try {
    const all = await loadCustomers();
    const session = await auth();
    csm = resolveCsmFilter(sp.csm, all, session?.user?.email);
    book = filterCustomers(all, { csm, segment });
    entCount = book.filter(isEnterprise).length;
    nonEntCount = book.length - entCount;
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  const totalArr = book.reduce((s, c) => s + c.arr, 0);

  return (
    <>
      <div className="mb-10">
        <h1 className="text-[40px] leading-[1.1] font-semibold text-fg tracking-tight">
          Portfolio overview
        </h1>
        <p className="text-[15px] text-muted mt-3">
          Data from{" "}
          <code className="bg-surface-2 px-1.5 py-0.5 rounded text-fg font-mono text-[13px]">
            {source}
          </code>
          {csm ? (
            <> · CSM <strong className="text-fg">{csm.replace(/_/g, " ")}</strong></>
          ) : null}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 mb-6">
          <p className="text-red-800 dark:text-red-300 font-medium">Failed to load data</p>
          <p className="text-red-600 text-sm mt-1">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Accounts" value={String(book.length)} />
        <Stat label="Total ARR" value={fmtCurrency(totalArr)} />
        <Stat label="Enterprise" value={String(entCount)} />
        <Stat label="Growth" value={String(nonEntCount)} />
      </div>

      <TeamTasksPanel />
      <PersonalTodosPanel />
      <FeatureUpdatesPanel />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-card px-5 py-5">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="text-[28px] leading-tight font-semibold mt-1 text-fg tracking-tight">
        {value}
      </p>
    </div>
  );
}
