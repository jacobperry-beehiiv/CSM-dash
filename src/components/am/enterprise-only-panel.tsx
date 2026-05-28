"use client";

import { useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtNumber, fmtPct } from "../format";
import { CsmSelector } from "../csm-selector";
import { RowActions } from "../row-actions";
import { OutreachModal } from "../outreach-modal";
import { BucketSection } from "./bucket-section";
import { BulkEmailLauncher } from "./bulk-email-launcher";

interface Props {
  rows: Customer[];
  csms: string[];
}

interface Bucket {
  label: string;
  test: (pct: number) => boolean;
  color: string;
}

const BUCKETS: Bucket[] = [
  {
    label: "≥100% — over cap",
    test: (p) => p >= 100,
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
  },
  {
    label: "95–99%",
    test: (p) => p >= 95 && p < 100,
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
  },
  {
    label: "90–94%",
    test: (p) => p >= 90 && p < 95,
    color: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900",
  },
  {
    label: "85–89%",
    test: (p) => p >= 85 && p < 90,
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
  },
];

function pct(c: Customer): number {
  if (c.percent_of_max_subs != null) {
    return c.percent_of_max_subs > 1
      ? c.percent_of_max_subs
      : c.percent_of_max_subs * 100;
  }
  if (c.active_subs != null && c.max_subscriptions) {
    return (c.active_subs / c.max_subscriptions) * 100;
  }
  return 0;
}

function priceLabel(c: Customer): string {
  const interval = (c.interval ?? "").toLowerCase();
  if (interval === "month" || interval === "monthly") {
    return `${fmtCurrency(c.mrr)}/mo`;
  }
  return `${fmtCurrency(c.arr)}/yr`;
}

export function EnterpriseOnlyPanel({ rows, csms }: Props) {
  const [outreachFor, setOutreachFor] = useState<Customer | null>(null);
  // Bulk-select state — keyed on workspace_id (the row's stable id).
  // Mirrors the past-due-panel pattern so all AM tabs feel the same.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const buckets = useMemo(() => {
    return BUCKETS.map((b) => ({
      bucket: b,
      list: rows
        .filter((c) => b.test(pct(c)))
        .sort((a, b) => pct(b) - pct(a)),
    })).filter((g) => g.list.length > 0);
  }, [rows]);

  const visibleRows = useMemo(
    () => buckets.flatMap((g) => g.list),
    [buckets]
  );

  function rowKey(c: Customer): string {
    return c.workspace_id ?? c.stripe_customer_id ?? c.workspace_name ?? "row";
  }

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const selectedCustomers = useMemo(
    () => visibleRows.filter((c) => selected.has(rowKey(c))),
    [visibleRows, selected]
  );

  return (
    <>
      <div className="flex items-center gap-3 mb-4 text-sm">
        <span className="text-xs text-muted">Filter:</span>
        <CsmSelector csms={csms} />
        <span className="text-xs text-muted ml-auto">
          {rows.length} Enterprise account{rows.length === 1 ? "" : "s"} at ≥85% of cap
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-muted">
          <strong>{selected.size}</strong> selected
        </span>
        <button
          onClick={() =>
            setSelected(new Set(visibleRows.map((c) => rowKey(c))))
          }
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
          title="Select every visible row (after filters)"
        >
          Select all
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        >
          Clear
        </button>
        <div className="flex-1" />
        {/* Enterprise outreach drafts auto-CC the assigned CSM per the
         *  brief. Same ccLookup pattern used on the Past Due Enterprise
         *  bulk launcher. */}
        <BulkEmailLauncher
          customers={selectedCustomers}
          defaultTemplateId="approaching-ent"
          disabled={selected.size === 0}
          label="✉️ Email selected (CCs CSM)"
          ccLookup={(c) => c.customer_success_manager_email ?? null}
        />
      </div>

      {buckets.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No Enterprise customers at or above 85% of cap. Nicely done.
        </div>
      ) : (
        <div className="space-y-4">
          {buckets.map(({ bucket, list }) => (
            <BucketSection
              key={bucket.label}
              label={bucket.label}
              count={list.length}
              toneClass={bucket.color}
              defaultOpen
            >
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-8" />
                  <col className="w-[26%]" />
                  <col className="w-[10%]" />
                  <col className="w-[13%]" />
                  <col className="w-[10%]" />
                  <col className="w-[13%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs text-muted border-y border-border text-left">
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 font-medium text-right">% of cap</th>
                    <th className="px-3 py-2 font-medium text-right">Subs / cap</th>
                    <th className="px-3 py-2 font-medium text-right">Price</th>
                    <th className="px-3 py-2 font-medium">CSM</th>
                    <th className="px-3 py-2 font-medium text-right">ARR</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => {
                    const k = rowKey(c);
                    return (
                    <tr
                      key={k}
                      className="border-b border-border hover:bg-blue-50 dark:bg-blue-500/40 align-top"
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(k)}
                          onChange={() => toggleSelected(k)}
                          className="h-4 w-4 rounded border-border-strong cursor-pointer"
                          aria-label={`Select ${c.company_name ?? c.workspace_name ?? "row"}`}
                        />
                      </td>
                      <td className="px-3 py-2 break-words">
                        <div className="font-medium text-fg">
                          {c.company_name ?? c.workspace_name ?? "—"}
                        </div>
                        <div className="text-xs text-muted truncate">
                          {c.property_main_contact ?? c.owner_email ?? ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {fmtPct(pct(c))}
                      </td>
                      <td className="px-3 py-2 text-right text-muted">
                        <div>{fmtNumber(c.active_subs)}</div>
                        <div className="text-xs text-muted">
                          / {fmtNumber(c.max_subscriptions)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-muted">
                        {priceLabel(c)}
                      </td>
                      <td className="px-3 py-2 text-muted break-words">
                        {c.customer_success_manager?.replace(/_/g, " ") ?? (
                          <span className="text-subtle italic">unassigned</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtCurrency(c.arr)}
                      </td>
                      <td className="px-3 py-2">
                        <RowActions customer={c} onDraft={setOutreachFor} />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </BucketSection>
          ))}
        </div>
      )}

      {outreachFor ? (
        <OutreachModal
          customer={outreachFor}
          onClose={() => setOutreachFor(null)}
        />
      ) : null}
    </>
  );
}
