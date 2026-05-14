"use client";

import { useEffect, useState } from "react";
import type { Customer } from "@/lib/types";
import type { AdNetworkRollup } from "@/lib/engines/ad-network-batch";
import { FilterPanel } from "./filters";

interface Props {
  customers: Customer[];
  /** Called whenever the user changes filter inputs. Returns the predicate
   *  the table should apply, or null when no filter is active. */
  onFilterChange: (
    predicate: ((c: Customer) => boolean) | null
  ) => void;
}

export function AdNetworkFilter({ customers, onFilterChange }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [data, setData] = useState<Record<string, AdNetworkRollup>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter parameters
  const [lastRunMode, setLastRunMode] = useState<"any" | "in_last" | "not_in_last">(
    "any"
  );
  const [lastRunDays, setLastRunDays] = useState(30);
  const [revenueMode, setRevenueMode] = useState<"any" | "over" | "under">("any");
  const [revenueAmount, setRevenueAmount] = useState(1000);

  // Lazy fetch: only hit the DB when the user actually expands the filter.
  useEffect(() => {
    if (!enabled) return;
    if (Object.keys(data).length > 0) return;
    setLoading(true);
    setError(null);
    const ids = customers
      .map((c) => c.workspace_id)
      .filter((x): x is string => Boolean(x));
    fetch("/api/ad-network-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_ids: ids }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as Record<string, AdNetworkRollup>;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Unknown"))
      .finally(() => setLoading(false));
  }, [enabled, customers, data]);

  // Re-emit predicate whenever filter inputs change
  useEffect(() => {
    if (!enabled || Object.keys(data).length === 0) {
      onFilterChange(null);
      return;
    }
    const checks: Array<(r: AdNetworkRollup | undefined) => boolean> = [];
    if (lastRunMode !== "any") {
      const cutoff = Date.now() - lastRunDays * 86400_000;
      if (lastRunMode === "in_last") {
        checks.push(
          (r) =>
            !!r?.last_ad_run && new Date(r.last_ad_run).getTime() >= cutoff
        );
      } else {
        // not_in_last: never ran OR last run before cutoff
        checks.push(
          (r) => !r?.last_ad_run || new Date(r.last_ad_run).getTime() < cutoff
        );
      }
    }
    if (revenueMode !== "any") {
      checks.push((r) => {
        const rev = r?.revenue_usd ?? 0;
        return revenueMode === "over"
          ? rev > revenueAmount
          : rev < revenueAmount;
      });
    }
    if (checks.length === 0) {
      onFilterChange(null);
      return;
    }
    onFilterChange((c: Customer) => {
      if (!c.workspace_id) return false;
      const r = data[c.workspace_id];
      return checks.every((fn) => fn(r));
    });
  }, [
    enabled,
    data,
    lastRunMode,
    lastRunDays,
    revenueMode,
    revenueAmount,
    onFilterChange,
  ]);

  return (
    <FilterPanel
      title="Ad-network filters"
      open={enabled}
      onOpenChange={setEnabled}
    >
      <div className="space-y-3">
        {loading ? (
          <div className="text-xs text-muted flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-border-strong border-t-gray-700 rounded-full animate-spin" />
            Loading ad-network roll-up for {customers.length} customers…
          </div>
        ) : null}

        {error ? (
          <div className="text-xs text-red-700 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded p-2">
            {error}
          </div>
        ) : null}

        {!loading && !error && Object.keys(data).length > 0 ? (
          <div className="text-xs text-muted">
            Loaded {Object.keys(data).length} orgs from Postgres.
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <fieldset className="border border-border rounded-md p-2">
            <legend className="text-xs text-muted px-1">Last ad run</legend>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={lastRunMode}
                onChange={(e) =>
                  setLastRunMode(
                    e.target.value as "any" | "in_last" | "not_in_last"
                  )
                }
                className="px-2 py-1 border border-border-strong rounded-md text-xs bg-surface"
              >
                <option value="any">Any</option>
                <option value="in_last">Has run in last…</option>
                <option value="not_in_last">Has not run in last…</option>
              </select>
              {lastRunMode !== "any" ? (
                <>
                  <input
                    type="number"
                    value={lastRunDays}
                    onChange={(e) =>
                      setLastRunDays(Math.max(1, Number(e.target.value)))
                    }
                    className="w-20 px-2 py-1 border border-border-strong rounded-md text-xs"
                  />
                  <span className="text-xs text-muted">days</span>
                </>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="border border-border rounded-md p-2">
            <legend className="text-xs text-muted px-1">
              Ad revenue (lifetime)
            </legend>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={revenueMode}
                onChange={(e) =>
                  setRevenueMode(e.target.value as "any" | "over" | "under")
                }
                className="px-2 py-1 border border-border-strong rounded-md text-xs bg-surface"
              >
                <option value="any">Any</option>
                <option value="over">Earned over…</option>
                <option value="under">Earned under…</option>
              </select>
              {revenueMode !== "any" ? (
                <>
                  <span className="text-xs text-muted">$</span>
                  <input
                    type="number"
                    value={revenueAmount}
                    onChange={(e) =>
                      setRevenueAmount(Math.max(0, Number(e.target.value)))
                    }
                    className="w-28 px-2 py-1 border border-border-strong rounded-md text-xs"
                  />
                </>
              ) : null}
            </div>
          </fieldset>
        </div>
      </div>
    </FilterPanel>
  );
}
