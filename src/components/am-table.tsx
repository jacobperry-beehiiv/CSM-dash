"use client";

import { Fragment, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtNumber, fmtPct } from "./format";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RowActions } from "./row-actions";
import { CsmSelector } from "./csm-selector";
import { FilterBar, SearchInput, SegmentToggle } from "./filters";
import { useUrlSearch } from "@/lib/hooks/use-url-search";

type Cohort = "approaching-cap" | "approaching-ent";

interface Row {
  customer: Customer;
  cohort: Cohort;
}

interface Props {
  rows: Row[];
  csms: string[];
}

const COHORT_LABEL: Record<Cohort, string> = {
  "approaching-cap": "Approaching cap",
  "approaching-ent": "Approaching enterprise",
};

const COHORT_STYLE: Record<Cohort, string> = {
  "approaching-cap": "bg-red-100 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/30",
  "approaching-ent": "bg-amber-100 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30",
};

const ENT_SUB_THRESHOLD = 100_000;

function utilPct(c: Customer): number | null {
  if (c.percent_of_max_subs != null) {
    return c.percent_of_max_subs > 1
      ? c.percent_of_max_subs
      : c.percent_of_max_subs * 100;
  }
  if (c.active_subs != null && c.max_subscriptions) {
    return (c.active_subs / c.max_subscriptions) * 100;
  }
  return null;
}

export function AmTable({ rows, csms }: Props) {
  const [search, setSearch] = useUrlSearch("q");
  const [cohortFilter, setCohortFilter] = useState<Cohort | "all">("all");
  const [outreachFor, setOutreachFor] = useState<{
    customer: Customer;
    cohort: Cohort;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const filtered = useMemo(() => {
    let list = rows;
    if (cohortFilter !== "all") {
      list = list.filter((r) => r.cohort === cohortFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        ({ customer: c }) =>
          c.company_name?.toLowerCase().includes(q) ||
          c.workspace_name?.toLowerCase().includes(q) ||
          c.property_main_contact?.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      if (a.cohort !== b.cohort)
        return a.cohort === "approaching-cap" ? -1 : 1;
      const au = utilPct(a.customer) ?? 0;
      const bu = utilPct(b.customer) ?? 0;
      if (bu !== au) return bu - au;
      return b.customer.arr - a.customer.arr;
    });
  }, [rows, search, cohortFilter]);

  const counts = {
    cap: rows.filter((r) => r.cohort === "approaching-cap").length,
    ent: rows.filter((r) => r.cohort === "approaching-ent").length,
  };

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card label="Approaching cap" value={String(counts.cap)} accent={counts.cap > 0} />
        <Card label="Approaching 100K subs" value={String(counts.ent)} accent={counts.ent > 0} />
        <Card
          label="Combined ARR"
          value={fmtCurrency(rows.reduce((s, r) => s + r.customer.arr, 0))}
        />
        <Card
          label="Combined subs"
          value={fmtNumber(rows.reduce((s, r) => s + (r.customer.active_subs ?? 0), 0))}
        />
      </div>

      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search company / contact…"
        />
        <CsmSelector csms={csms} />
        <SegmentToggle
          options={[
            { value: "all", label: "All" },
            { value: "approaching-cap", label: "Approaching cap", count: counts.cap },
            { value: "approaching-ent", label: "Approaching 100K subs", count: counts.ent },
          ]}
          value={cohortFilter}
          onChange={(v) => setCohortFilter(v)}
        />
      </FilterBar>

      <div className="rounded-xl border border-border bg-surface shadow-card">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-8" />
            <col className="w-[20%]" />
            <col className="w-[14%]" />
            <col className="w-[10%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[10%] hidden lg:table-cell" />
            <col className="w-[16%]" />
          </colgroup>
          <thead className="bg-canvas">
            <tr className="text-left border-b border-border">
              <th className="px-3 py-3"></th>
              <th className="px-3 py-3 font-medium text-muted">Account</th>
              <th className="px-3 py-3 font-medium text-muted">Cohort</th>
              <th className="px-3 py-3 font-medium text-muted">Plan</th>
              <th className="px-3 py-3 font-medium text-muted text-right">Subs</th>
              <th className="px-3 py-3 font-medium text-muted text-right">% limit</th>
              <th className="px-3 py-3 font-medium text-muted text-right">ARR</th>
              <th className="px-3 py-3 font-medium text-muted hidden lg:table-cell">CSM</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ customer: c, cohort }, i) => {
              const k = `${cohort}-${c.workspace_id ?? i}`;
              const isOpen = expanded.has(k);
              const u = utilPct(c);
              const utilColor =
                u != null && u > 90
                  ? "text-red-600 font-semibold"
                  : u != null && u > 80
                    ? "text-amber-600"
                    : "";
              const subDetail =
                cohort === "approaching-ent"
                  ? `${fmtNumber(c.active_subs)} / ${fmtNumber(ENT_SUB_THRESHOLD)}`
                  : `${fmtNumber(c.active_subs)} / ${fmtNumber(c.max_subscriptions)}`;
              return (
                <Fragment key={k}>
                  <tr
                    onClick={() => toggleExpanded(k)}
                    className={`border-b border-border hover:bg-blue-50 dark:bg-blue-500/40 align-top cursor-pointer transition-colors ${
                      isOpen ? "bg-blue-50 dark:bg-blue-500/40" : ""
                    }`}
                  >
                    <td className="px-3 py-2.5 text-subtle select-none">
                      <span
                        className={`inline-block transition-transform ${
                          isOpen ? "rotate-90" : ""
                        }`}
                      >
                        ▸
                      </span>
                    </td>
                    <td className="px-3 py-2.5 break-words">
                      <div className="font-medium text-fg">
                        {c.company_name ?? c.workspace_name ?? "—"}
                      </div>
                      <div className="text-xs text-muted break-words">
                        {c.property_main_contact ?? c.owner_email ?? ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${COHORT_STYLE[cohort]}`}
                      >
                        {COHORT_LABEL[cohort]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-muted break-words">
                      <div>{c.stripe_plan ?? "—"}</div>
                      {c.interval ? (
                        <div className="text-xs text-muted">{c.interval}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div>{fmtNumber(c.active_subs)}</div>
                      <div className="text-xs text-muted">{subDetail}</div>
                    </td>
                    <td className={`px-3 py-2.5 text-right ${utilColor}`}>
                      {fmtPct(u)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {fmtCurrency(c.arr)}
                    </td>
                    <td className="px-3 py-2.5 text-muted hidden lg:table-cell break-words">
                      {c.customer_success_manager?.replace(/_/g, " ") ?? (
                        <span className="text-subtle italic">unassigned</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <RowActions
                        customer={c}
                        onDraft={(cust) => setOutreachFor({ customer: cust, cohort })}
                      />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-blue-50 dark:bg-blue-500/20 border-b border-border">
                      <td colSpan={9} className="px-6 py-4">
                        <CustomerDetailPanel customer={c} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center text-muted py-8 text-sm">
            No accounts match the current filter.
          </div>
        )}
      </div>

      <p className="text-xs text-subtle mt-2">
        Showing {filtered.length} of {rows.length} accounts. Click a row for full
        details.
      </p>

      {outreachFor && (
        <OutreachModal
          customer={outreachFor.customer}
          onClose={() => setOutreachFor(null)}
          initialScenario={
            outreachFor.cohort === "approaching-ent"
              ? "approaching-ent"
              : "general-checkin"
          }
        />
      )}
    </>
  );
}

function Card({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        accent
          ? "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30"
          : "bg-surface border-border"
      }`}
    >
      <p className="text-sm text-muted">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
    </div>
  );
}
