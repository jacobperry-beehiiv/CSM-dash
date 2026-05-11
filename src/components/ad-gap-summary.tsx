"use client";

import { useState } from "react";
import type { AdGapReport } from "@/lib/types";
import { fmtCurrency, fmtNumber, fmtRate } from "./format";

interface ApiResponse {
  matches: { id: string; name: string; owner_email: string | null }[];
  report: AdGapReport | null;
  error?: string;
}

function daysAgoUtc(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface Props {
  organizationId: string | null | undefined;
}

/**
 * Inline ad-gap analysis for a single org. Defers the network call until
 * the user clicks "Run analysis" since the underlying Postgres query is
 * heavier than other panels and not always relevant.
 */
export function AdGapSummary({ organizationId }: Props) {
  const [data, setData] = useState<AdGapReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        organization_id: organizationId,
        start: daysAgoUtc(90),
        end: daysAgoUtc(0),
      });
      const res = await fetch(`/api/ad-gap?${qs.toString()}`);
      const json = (await res.json()) as ApiResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json.report ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  if (!organizationId) return null;

  return (
    <div className="rounded-md border border-border bg-surface p-3 space-y-3">
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Ad Network Gap (last 90 days)
        </h4>
        {data ? (
          <span className="text-[10px] text-subtle">
            {data.publications.length} pubs · {fmtNumber(data.total_subscribers)}{" "}
            subs
          </span>
        ) : null}
      </div>

      {!data && !loading && !error ? (
        <button
          onClick={run}
          className="text-xs px-3 py-1.5 border border-border-strong rounded-md hover:bg-canvas"
        >
          Run analysis
        </button>
      ) : null}

      {loading ? (
        <div className="text-xs text-muted flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-border-strong border-t-gray-700 rounded-full animate-spin" />
          Querying ad network…
        </div>
      ) : null}

      {error ? (
        <div className="text-xs text-red-700 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded p-2">
          {error}
        </div>
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <Stat
              label="Actual earnings"
              value={fmtCurrency(data.portfolio_actual_dollars)}
              tooltip="Sum of approved disbursements (actual paid revenue) for the customer in the period."
            />
            <Stat
              label="Potential earnings"
              value={fmtCurrency(data.portfolio_potential_at_full_fill_dollars)}
              tooltip={`Per pub: total_opportunities × per_ad_rate. Total opportunities = accepted + canceled + missed. Per-ad rate cascade: (1) the pub's own avg actual payout, else (2) portfolio-weighted avg (sum-actual / sum-accepted), else (3) configurable fallback rate × subs/1000 (set on /settings/general). For pubs that are sending with no opportunities yet, falls back to sends × per_ad_rate.`}
            />
            <Stat
              label="Gap"
              value={fmtCurrency(
                Math.max(
                  0,
                  data.portfolio_potential_at_full_fill_dollars -
                    data.portfolio_actual_dollars
                )
              )}
              accent
              tooltip="Potential earnings minus actual — what the customer is leaving on the table."
            />
          </div>

          {data.zero_ad_sending_pubs.length > 0 ? (
            <div className="rounded border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-2 text-xs text-amber-900">
              <strong>{data.zero_ad_sending_pubs.length}</strong> actively-sending
              pub{data.zero_ad_sending_pubs.length === 1 ? "" : "s"} with zero ad
              placements:{" "}
              {data.zero_ad_sending_pubs
                .slice(0, 3)
                .map((p) => p.publication_name)
                .join(", ")}
              {data.zero_ad_sending_pubs.length > 3 ? ", …" : ""}
            </div>
          ) : null}

          <details className="text-xs">
            <summary className="cursor-pointer text-blue-600 dark:text-blue-400 hover:underline">
              Per-publication breakdown
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted">
                  <tr className="text-left border-b border-border">
                    <th className="px-2 py-1 font-medium">Publication</th>
                    <th className="px-2 py-1 font-medium text-right">Subs</th>
                    <th className="px-2 py-1 font-medium text-right">Sends</th>
                    <th className="px-2 py-1 font-medium text-right">Acc</th>
                    <th className="px-2 py-1 font-medium text-right">Missed</th>
                    <th className="px-2 py-1 font-medium text-right">Fill</th>
                    <th className="px-2 py-1 font-medium text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.publications.map((p) => (
                    <tr key={p.publication_id} className="border-b border-border">
                      <td className="px-2 py-1">{p.publication_name}</td>
                      <td className="px-2 py-1 text-right">
                        {fmtNumber(p.subscribers)}
                      </td>
                      <td className="px-2 py-1 text-right">{p.sends_in_period}</td>
                      <td className="px-2 py-1 text-right">{p.ads_accepted}</td>
                      <td className="px-2 py-1 text-right text-red-700">
                        {p.ads_missed}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {fmtRate(p.fill_rate)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {fmtCurrency(p.actual_payout_dollars)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  tooltip,
}: {
  label: string;
  value: string;
  accent?: boolean;
  tooltip?: string;
}) {
  return (
    <div
      className={`rounded border p-2 ${
        accent
          ? "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/60"
          : "border-border bg-canvas/40"
      }`}
      title={tooltip}
    >
      <div className="text-[10px] text-muted uppercase tracking-wide flex items-center gap-1">
        {label}
        {tooltip ? (
          <span className="text-subtle" aria-hidden>
            ⓘ
          </span>
        ) : null}
      </div>
      <div className="text-base font-semibold mt-0.5">{value}</div>
    </div>
  );
}
