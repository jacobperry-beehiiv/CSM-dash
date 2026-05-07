"use client";

import { useMemo, useState } from "react";
import type { ApproachingEntRow } from "@/lib/engines/am-cohorts";
import { fmtCompactCurrency, fmtDate, fmtNumber, fmtPct } from "../format";
import { BucketSection } from "./bucket-section";

interface Props {
  rows: ApproachingEntRow[];
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
    color: "bg-red-50 border-red-200 text-red-900",
  },
  {
    label: "95–99%",
    test: (p) => p >= 95 && p < 100,
    color: "bg-red-50 border-red-200 text-red-900",
  },
  {
    label: "90–94%",
    test: (p) => p >= 90 && p < 95,
    color: "bg-amber-50 border-amber-200 text-amber-900",
  },
  {
    label: "85–89%",
    test: (p) => p >= 85 && p < 90,
    color: "bg-amber-50 border-amber-200 text-amber-900",
  },
  {
    label: "80–84%",
    test: (p) => p >= 80 && p < 85,
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
  },
  {
    label: "75–79%",
    test: (p) => p >= 75 && p < 80,
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
  },
];

/** q13268's percent_to is a fraction (0.875 = 87.5%, 1.43 = 143%). */
function pctNum(r: ApproachingEntRow): number | null {
  if (r.percent_to == null) return null;
  return r.percent_to * 100;
}

function priceLabel(r: ApproachingEntRow): string {
  if (r.last_payment_amount == null) return "—";
  const interval = (r.billing_interval ?? "").toLowerCase();
  const suffix =
    interval === "month" || interval === "monthly" ? "/mo" : "/yr";
  return `${fmtCompactCurrency(r.last_payment_amount)}${suffix}`;
}

export function ApproachingEnterprisePanel({ rows }: Props) {
  const [search, setSearch] = useState("");

  // Filter to ≥75% utilization, then bucket. q13268 returns customers
  // approaching the 100K Enterprise threshold — they're already a curated
  // pool, but the user wants the panel to focus on those actually close
  // to/over their plan limit.
  const buckets = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows
      .filter((r) => {
        const p = pctNum(r);
        if (p == null || p < 75) return false;
        if (!q) return true;
        return (
          r.workspace_name?.toLowerCase().includes(q) ||
          r.owner_name?.toLowerCase().includes(q) ||
          r.owner_email?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (pctNum(b) ?? 0) - (pctNum(a) ?? 0));
    return BUCKETS.map((b) => ({
      bucket: b,
      list: filtered.filter((r) => {
        const p = pctNum(r);
        return p != null && b.test(p);
      }),
    })).filter((g) => g.list.length > 0);
  }, [rows, search]);

  const totalAtOrAbove75 = rows.filter((r) => {
    const p = pctNum(r);
    return p != null && p >= 75;
  }).length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="text"
          placeholder="Search workspace / owner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm flex-1 min-w-[220px]"
        />
        <span className="text-xs text-gray-500 ml-auto">
          {totalAtOrAbove75} of {rows.length} q13268 rows at ≥75% of plan limit
        </span>
      </div>

      {buckets.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No approaching-Enterprise accounts at ≥75% of their plan limit.
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
                  <col className="w-[24%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[14%]" />
                  <col className="w-[8%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs text-gray-500 border-y border-gray-200 text-left">
                    <th className="px-3 py-2 font-medium">Workspace</th>
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 font-medium text-right">Price</th>
                    <th className="px-3 py-2 font-medium text-right">
                      Subs / cap
                    </th>
                    <th className="px-3 py-2 font-medium text-right">% cap</th>
                    <th className="px-3 py-2 font-medium">Last send</th>
                    <th className="px-3 py-2 font-medium">Last payment</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const p = pctNum(r);
                    return (
                      <tr
                        key={r.organization_id ?? r.workspace_name ?? Math.random()}
                        className="border-b border-gray-100 hover:bg-blue-50/40 align-top"
                      >
                        <td className="px-3 py-2 break-words">
                          <div className="font-medium text-gray-900">
                            {r.workspace_name ?? "—"}
                          </div>
                          <div className="text-xs text-gray-500 truncate">
                            {r.owner_name ?? r.owner_email ?? ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-gray-700">
                          {r.plan_name ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-700">
                          {priceLabel(r)}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-700">
                          <div>{fmtNumber(r.total_subscriptions)}</div>
                          <div className="text-xs text-gray-500">
                            / {fmtNumber(r.max_subscriptions)}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-semibold">
                          {fmtPct(p)}
                        </td>
                        <td className="px-3 py-2 text-gray-700 text-xs">
                          {fmtDate(r.last_send)}
                        </td>
                        <td className="px-3 py-2 text-gray-700 text-xs">
                          {fmtDate(r.last_payment_at)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            {r.masquerade_url ? (
                              <a
                                href={r.masquerade_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Masquerade into workspace"
                                className="px-2 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50"
                              >
                                👤
                              </a>
                            ) : null}
                            {r.owner_email ? (
                              <a
                                href={`mailto:${encodeURIComponent(
                                  r.owner_email
                                )}`}
                                title={`Email ${r.owner_email}`}
                                className="px-2 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50"
                              >
                                ✉️
                              </a>
                            ) : null}
                          </div>
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
      <p className="text-xs text-gray-400 mt-2">
        Source: Metabase q13268. Filter:{" "}
        <code className="font-mono bg-gray-100 px-1 rounded">
          percent_to ≥ 0.75
        </code>
        . Refresh the page to re-fetch (10-min in-process cache).
      </p>
    </>
  );
}
