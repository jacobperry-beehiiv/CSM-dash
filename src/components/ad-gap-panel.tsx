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

export function AdGapPanel() {
  const [query, setQuery] = useState("");
  const [orgId, setOrgId] = useState("");
  const [start, setStart] = useState(daysAgoUtc(90));
  const [end, setEnd] = useState(daysAgoUtc(0));
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(overrideOrgId?: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ start, end });
      if (overrideOrgId) qs.set("organization_id", overrideOrgId);
      else if (orgId) qs.set("organization_id", orgId);
      else if (query) qs.set("q", query);
      else throw new Error("Enter an org name or org ID");

      const res = await fetch(`/api/ad-gap?${qs.toString()}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: "request failed" }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setLoading(false);
    }
  }

  const report = data?.report ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Org name fragment (e.g. Milk Road)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-md text-sm w-64"
        />
        <input
          type="text"
          placeholder="or org ID"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-md text-sm w-56"
        />
        <label className="text-sm text-gray-600">
          From
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="ml-2 px-3 py-1 border border-gray-300 rounded-md text-sm"
          />
        </label>
        <label className="text-sm text-gray-600">
          To
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="ml-2 px-3 py-1 border border-gray-300 rounded-md text-sm"
          />
        </label>
        <button
          onClick={() => run()}
          disabled={loading}
          className="px-4 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
        >
          {loading ? "Running…" : "Analyze"}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {data && !report && data.matches.length > 1 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-sm text-gray-600 mb-2">
            Multiple orgs match. Pick one:
          </p>
          <div className="space-y-1">
            {data.matches.map((m) => (
              <button
                key={m.id}
                onClick={() => run(m.id)}
                className="block text-left w-full px-3 py-2 rounded hover:bg-gray-50 text-sm"
              >
                <span className="font-medium">{m.name}</span>{" "}
                <span className="text-gray-500 text-xs ml-2">
                  {m.owner_email ?? ""} · {m.id}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {data && !report && data.matches.length === 0 && (
        <div className="text-sm text-gray-500">No matching organizations.</div>
      )}

      {report && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-lg font-semibold">
                {report.organization_name}
              </h3>
              <span className="text-xs text-gray-500">
                {report.owner_email} · {report.organization_id}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              <Stat
                label="Publications"
                value={String(report.publications.length)}
              />
              <Stat
                label="Total subscribers"
                value={fmtNumber(report.total_subscribers)}
              />
              <Stat
                label="Actual revenue"
                value={fmtCurrency(report.portfolio_actual_dollars)}
              />
              <Stat
                label="Potential at 100% fill"
                value={fmtCurrency(report.portfolio_potential_at_full_fill_dollars)}
              />
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg">
            <table className="w-full text-sm table-auto">
              <thead className="bg-gray-50">
                <tr className="text-left border-b border-gray-200">
                  <th className="px-3 py-2 font-medium text-gray-600">Publication</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">Subs</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">Sends</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-center">Enrolled</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">Accepted</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">Missed</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">Fill</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {report.publications.map((p) => {
                  const zeroAd = p.ads_accepted === 0 && p.sends_in_period > 0;
                  return (
                    <tr
                      key={p.publication_id}
                      className={`border-b border-gray-100 ${zeroAd ? "font-semibold bg-amber-50/50" : ""}`}
                    >
                      <td className="px-3 py-2">{p.publication_name}</td>
                      <td className="px-3 py-2 text-right">
                        {fmtNumber(p.subscribers)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {p.sends_in_period}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {p.has_ad_profile ? "✓" : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">{p.ads_accepted}</td>
                      <td className="px-3 py-2 text-right text-red-700">
                        {p.ads_missed}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtRate(p.fill_rate)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtCurrency(p.actual_payout_dollars)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {report.zero_ad_sending_pubs.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h4 className="font-semibold text-amber-900">
                {report.zero_ad_sending_pubs.length} actively-sending publications
                with zero ad placements
              </h4>
              <ul className="mt-2 space-y-1 text-sm text-amber-900">
                {report.zero_ad_sending_pubs.slice(0, 10).map((p) => (
                  <li key={p.publication_id}>
                    {p.publication_name} — {fmtNumber(p.subscribers)} subs,{" "}
                    {p.sends_in_period} sends
                    {!p.has_ad_profile && (
                      <span className="ml-2 text-xs text-amber-700">
                        (not enrolled in ad network)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{value}</div>
    </div>
  );
}
