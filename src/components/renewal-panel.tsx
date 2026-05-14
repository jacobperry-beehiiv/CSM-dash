"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtDate, daysUntil } from "./format";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RowActions } from "./row-actions";
import { FilterBar, SearchInput, SelectFilter } from "./filters";
import { CsmSelector } from "./csm-selector";

/**
 * Computes the customer's next renewal/charge date.
 *
 * Monthly customers' `next_invoice` from Stripe can drift far past 30 days
 * (it represents the end of the current paid period, not the next monthly
 * charge). For monthly cadences we instead take the day-of-month from
 * next_invoice and roll forward to the next occurrence from today.
 *
 * Annual / other cadences use the date as-is.
 */
function nextRenewalDate(c: Customer): string | null {
  const baseStr = c.next_invoice ?? c.renewal_date;
  if (!baseStr) return null;
  const base = new Date(baseStr);
  if (isNaN(base.getTime())) return null;

  const interval = (c.interval ?? "").toLowerCase();
  const isMonthly = interval === "month" || interval === "monthly";
  if (!isMonthly) return baseStr;

  const day = base.getUTCDate();
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  let candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day);
  if (candidate < today) {
    candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day);
  }
  return new Date(candidate).toISOString();
}

interface Props {
  customers: Customer[];
  csms: string[];
}

interface Bucket {
  label: string;
  detail: string;
  color: string;
  match: (days: number) => boolean;
}

const BUCKETS: Bucket[] = [
  {
    label: "Past due",
    detail: "renewal date in the past",
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
    match: (d) => d < 0,
  },
  {
    label: "≤ 30 days",
    detail: "in the next 30 days",
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
    match: (d) => d >= 0 && d <= 30,
  },
  {
    label: "31–60 days",
    detail: "31–60 days out",
    color: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900",
    match: (d) => d > 30 && d <= 60,
  },
  {
    label: "61–90 days",
    detail: "61–90 days out",
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
    match: (d) => d > 60 && d <= 90,
  },
];

function intervalLabel(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t === "month" || t === "monthly") return "Monthly";
  if (t === "year" || t === "annual" || t === "yearly") return "Annual";
  // Title-case anything else ("3x a year", "quarterly", …)
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function RenewalPanel({ customers, csms }: Props) {
  const [selected, setSelected] = useState<Customer | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [intervalFilter, setIntervalFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  // Reset row-level state when the underlying customer set changes (CSM
  // filter / segment switch). Without this, "expanded" keeps stale
  // workspace IDs and the cadence dropdown shows a count that doesn't
  // match the rendered table.
  const customerSignature = useMemo(
    () => customers.map((c) => c.workspace_id ?? "").sort().join("|"),
    [customers]
  );
  useEffect(() => {
    setExpanded(new Set());
    setIntervalFilter("");
    setSearch("");
  }, [customerSignature]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const intervals = useMemo(() => {
    const set = new Set<string>();
    for (const c of customers) {
      if (c.interval) set.add(c.interval);
    }
    return [...set].sort();
  }, [customers]);

  const filtered = useMemo(() => {
    let list = customers;
    if (intervalFilter) {
      list = list.filter((c) => c.interval === intervalFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.company_name?.toLowerCase().includes(q) ||
          c.workspace_name?.toLowerCase().includes(q) ||
          c.owner_email?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [customers, intervalFilter, search]);

  const buckets = useMemo(() => {
    return BUCKETS.map((b) => {
      const list = filtered
        .map((c) => {
          const date = nextRenewalDate(c);
          return { c, date, days: daysUntil(date) };
        })
        .filter(({ days }) => days != null && b.match(days as number))
        .sort((a, b) => b.c.arr - a.c.arr);
      return { bucket: b, list };
    });
  }, [filtered]);

  const totalInWindow = buckets.reduce((s, x) => s + x.list.length, 0);

  const cadencePicker = (
    <FilterBar>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search company or workspace…"
      />
      <CsmSelector csms={csms} />
      <SelectFilter
        label="Cadence"
        value={intervalFilter}
        onChange={(v) => setIntervalFilter(v)}
        emptyLabel="All cadences"
        emptyCount={customers.filter((c) => c.interval).length}
        options={intervals.map((i) => ({
          value: i,
          label: intervalLabel(i),
          count: customers.filter((c) => c.interval === i).length,
        }))}
      />
    </FilterBar>
  );

  if (totalInWindow === 0) {
    return (
      <>
        {cadencePicker}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No renewals in the next 90 days
          {intervalFilter ? ` for ${intervalLabel(intervalFilter)} customers` : ""}.
        </div>
      </>
    );
  }

  return (
    <div className="space-y-6">
      {cadencePicker}
      {buckets.map(({ bucket, list }, bucketIdx) =>
        list.length === 0 ? null : (
          <div
            key={bucket.label}
            className={`border rounded-lg overflow-hidden ${bucket.color}`}
          >
            <div className="px-4 py-2.5 flex items-baseline justify-between">
              <h3 className="font-semibold">{bucket.label}</h3>
              <span className="text-xs">
                {list.length} account{list.length === 1 ? "" : "s"} · {bucket.detail}
              </span>
            </div>
            <table className="w-full text-sm bg-surface table-fixed">
              <colgroup>
                <col className="w-8" />
                <col className="w-[36%]" />
                <col className="w-[12%]" />
                <col className="w-[14%]" />
                <col className="w-[8%]" />
                <col className="w-[14%] hidden lg:table-cell" />
                <col className="w-[16%]" />
              </colgroup>
              <thead>
                <tr className="text-left border-y border-border text-xs text-muted">
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 font-medium text-right">ARR</th>
                  <th className="px-3 py-2 font-medium">Renewal</th>
                  <th className="px-3 py-2 font-medium">Days</th>
                  <th className="px-3 py-2 font-medium hidden lg:table-cell">CSM</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {list.map(({ c, date, days }, idx) => {
                  const k = `${bucketIdx}-${c.workspace_id ?? idx}`;
                  const isOpen = expanded.has(k);
                  return (
                    <Fragment key={k}>
                      <tr
                        onClick={() => toggleExpanded(k)}
                        className={`border-b border-border align-top cursor-pointer transition-colors ${
                          isOpen ? "bg-blue-50 dark:bg-blue-500/40" : "hover:bg-blue-50 dark:bg-blue-500/40"
                        }`}
                      >
                        <td className="px-3 py-2 text-subtle select-none">
                          <span
                            className={`inline-block transition-transform ${
                              isOpen ? "rotate-90" : ""
                            }`}
                          >
                            ▸
                          </span>
                        </td>
                        <td className="px-3 py-2 break-words">
                          <div className="font-medium text-fg">
                            {c.company_name ?? c.workspace_name ?? "—"}
                          </div>
                          <div className="text-xs text-muted truncate">
                            {c.property_main_contact ?? c.owner_email ?? ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {fmtCurrency(c.arr)}
                        </td>
                        <td className="px-3 py-2 text-muted">
                          <div>{fmtDate(date ?? null)}</div>
                          {c.interval ? (
                            <div className="text-xs text-muted">
                              {c.interval === "month" ? "monthly" : c.interval}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 font-medium text-fg">
                          {days}
                        </td>
                        <td className="px-3 py-2 text-muted hidden lg:table-cell break-words">
                          {c.customer_success_manager?.replace(/_/g, " ") ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <RowActions customer={c} onDraft={setSelected} />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-blue-50 dark:bg-blue-500/20 border-b border-border">
                          <td colSpan={7} className="px-6 py-4">
                            <CustomerDetailPanel customer={c} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {selected && (
        <OutreachModal
          customer={selected}
          onClose={() => setSelected(null)}
          initialScenario="renewal-30d"
        />
      )}
    </div>
  );
}
