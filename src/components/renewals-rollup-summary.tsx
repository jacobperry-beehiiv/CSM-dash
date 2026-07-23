"use client";

import { useMemo } from "react";
import type { Customer } from "@/lib/types";
import { fmtCurrency } from "./format";
import { intervalBucket } from "@/lib/customer-helpers";
import { daysUntilRenewal, nextRenewalDate } from "@/lib/renewals/date";

/**
 * Team-wide pacing summary shown at the top of the Renewals panel
 * when the viewer picked "All CSMs" (?csm=all). Renders four bucket
 * tiles matching the panel's forward-time BUCKETS:
 *   • Past due
 *   • ≤ 30 days
 *   • 31–60 days
 *   • 61–90 days
 *
 * Each tile shows the account count, aggregate ARR, and a mini
 * breakdown by lifecycle stage — enough context for Juliet + Priya
 * to see who's closed, who's chasing, and who's silent without
 * scrolling through the per-row list.
 *
 * Uses the same data that's already loaded by the panel (no new
 * network round-trip). Runs the same monthly + terminal-stage
 * filter the panel + milestone engine both use so the tile counts
 * agree with the visible rows.
 */

interface Props {
  customers: Customer[];
  /** Live overrides keyed by workspace_id — so a CSM-edited
   *  lifecycle stage is reflected in the mini-breakdown even before
   *  q10600 catches up. Matches the panel's own state shape. */
  overrides: Record<string, { lifecycle_stage?: string } | undefined>;
}

const BUCKETS: {
  key: string;
  label: string;
  detail: string;
  color: string;
  match: (days: number) => boolean;
}[] = [
  {
    key: "past-due",
    label: "Past due",
    detail: "renewal date passed",
    color:
      "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
    match: (d) => d < 0,
  },
  {
    key: "d30",
    label: "≤ 30 days",
    detail: "in the next 30 days",
    color:
      "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
    match: (d) => d >= 0 && d <= 30,
  },
  {
    key: "d31_60",
    label: "31–60 days",
    detail: "31–60 days out",
    color:
      "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900",
    match: (d) => d > 30 && d <= 60,
  },
  {
    key: "d61_90",
    label: "61–90 days",
    detail: "61–90 days out",
    color:
      "bg-yellow-50 dark:bg-yellow-500/10 border-yellow-200 dark:border-yellow-500/30 text-yellow-900",
    match: (d) => d > 60 && d <= 90,
  },
];

const TERMINAL_STAGES = new Set(["Renewal Confirmed", "Renewal Lost"]);

interface BucketData {
  count: number;
  arr: number;
  byStage: Map<string, number>;
}

function emptyBucket(): BucketData {
  return { count: 0, arr: 0, byStage: new Map() };
}

export function RenewalsRollupSummary({ customers, overrides }: Props) {
  const buckets = useMemo(() => {
    const result = new Map<string, BucketData>(
      BUCKETS.map((b) => [b.key, emptyBucket()])
    );
    const now = new Date();
    for (const c of customers) {
      if (!c.workspace_id) continue;
      if (intervalBucket(c) === "monthly") continue;
      const stage =
        overrides[c.workspace_id]?.lifecycle_stage?.trim() ?? "";
      if (stage && TERMINAL_STAGES.has(stage)) continue;
      const renewalIso = nextRenewalDate(c);
      const days = daysUntilRenewal(renewalIso, now);
      if (days == null) continue;
      const bucket = BUCKETS.find((b) => b.match(days));
      if (!bucket) continue;
      const slot = result.get(bucket.key) ?? emptyBucket();
      slot.count += 1;
      slot.arr += c.arr ?? 0;
      const label = stage || "Unset";
      slot.byStage.set(label, (slot.byStage.get(label) ?? 0) + 1);
      result.set(bucket.key, slot);
    }
    return result;
  }, [customers, overrides]);

  return (
    <section className="rounded-xl border border-border shadow-card bg-surface p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-fg">
          Team pacing — next 90 days
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Counts + ARR at risk by bucket, plus a mini breakdown of
          where each cohort sits in the lifecycle. Team-view only —
          switch back to a specific CSM to see per-owner context.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {BUCKETS.map((b) => {
          const data = buckets.get(b.key) ?? emptyBucket();
          const stages = Array.from(data.byStage.entries()).sort(
            (a, z) => z[1] - a[1]
          );
          return (
            <div
              key={b.key}
              className={`rounded-lg border p-3 ${b.color} dark:text-fg`}
            >
              <div className="text-xs font-medium opacity-75">
                {b.label}
              </div>
              <div className="text-2xl font-semibold mt-0.5">
                {data.count}
              </div>
              <div className="text-xs opacity-75 mt-0.5">
                {fmtCurrency(data.arr)} ARR · {b.detail}
              </div>
              {stages.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {stages.slice(0, 4).map(([stage, n]) => (
                    <li key={stage} className="flex justify-between gap-2">
                      <span className="truncate">{stage}</span>
                      <span className="font-mono opacity-75">{n}</span>
                    </li>
                  ))}
                  {stages.length > 4 ? (
                    <li className="opacity-60 italic">
                      +{stages.length - 4} more
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="text-xs opacity-60 italic mt-2">
                  No accounts in this bucket.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
