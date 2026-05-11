"use client";

import { useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import {
  FEATURE_BATCH_KEYS,
  FEATURE_BATCH_LABELS,
  type FeatureBatchKey,
  type FeatureBatchMap,
} from "@/lib/engines/feature-utilization-batch";

interface Props {
  customers: Customer[];
  /** Called whenever the filter changes. `null` clears the filter. */
  onFilterChange: (predicate: ((c: Customer) => boolean) | null) => void;
}

type Combine = "any" | "all";
type Mode = "using" | "not_using";

/** Groupings for the 11 panel features — keeps the layout readable. */
const FEATURE_GROUPS: Array<{
  group: string;
  keys: ReadonlyArray<FeatureBatchKey>;
}> = [
  { group: "Monetization", keys: ["ad_network", "direct_sponsorships", "boost_monetize"] },
  { group: "Growth", keys: ["boost_grow", "referrals"] },
  { group: "Engagement", keys: ["podcasts", "automations", "segments", "polls"] },
  { group: "Onboarding", keys: ["t4", "mcp"] },
];

/**
 * Book-level feature filter. Mirrors the 11 features shown in the per-
 * customer Enterprise Feature Utilization panel. The first time the user
 * opens the filter we POST every workspace_id to /api/feature-utilization-
 * batch in a single trip — Postgres returns a {org → active flags} map that
 * the predicate consults locally on every filter change.
 */
export function FeatureUtilizationFilter({ customers, onFilterChange }: Props) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<FeatureBatchKey>>(new Set());
  const [combine, setCombine] = useState<Combine>("any");
  const [mode, setMode] = useState<Mode>("not_using");

  const [data, setData] = useState<FeatureBatchMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-fetch the batch when the panel first expands.
  useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    setError(null);
    const ids = customers
      .map((c) => c.workspace_id)
      .filter((id): id is string => Boolean(id));
    fetch("/api/feature-utilization-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_ids: ids }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as FeatureBatchMap;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Unknown"))
      .finally(() => setLoading(false));
  }, [open, data, loading, customers]);

  function toggle(key: FeatureBatchKey) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectGroup(keys: ReadonlyArray<FeatureBatchKey>) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }

  function clearGroup(keys: ReadonlyArray<FeatureBatchKey>) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  }

  function clear() {
    setPicked(new Set());
  }

  // Emit predicate whenever inputs change. We always run via the fetched map
  // — if the batch hasn't loaded yet (or an org is missing from the map), we
  // treat the customer as "no usage" so they show up only in "not using"
  // mode. That matches the panel's behaviour for unenrolled customers.
  useEffect(() => {
    if (picked.size === 0 || !data) {
      onFilterChange(null);
      return;
    }
    const matchesMode = (active: boolean) =>
      mode === "using" ? active : !active;

    onFilterChange((c: Customer) => {
      if (!c.workspace_id) return mode === "not_using";
      const row = data[c.workspace_id];
      if (combine === "any") {
        for (const k of picked) if (matchesMode(Boolean(row?.[k]))) return true;
        return false;
      }
      for (const k of picked) if (!matchesMode(Boolean(row?.[k]))) return false;
      return true;
    });
  }, [picked, combine, mode, data, onFilterChange]);

  // Per-feature match count — drives the small "N customers" hint next to
  // each checkbox so the user knows what the filter would do before they
  // commit to it.
  const perFeatureCount = useMemo(() => {
    if (!data) return null;
    const map = {} as Record<FeatureBatchKey, number>;
    for (const k of FEATURE_BATCH_KEYS) map[k] = 0;
    for (const c of customers) {
      if (!c.workspace_id) continue;
      const row = data[c.workspace_id];
      if (!row) continue;
      for (const k of FEATURE_BATCH_KEYS) {
        const active = Boolean(row[k]);
        if ((mode === "using" && active) || (mode === "not_using" && !active)) {
          map[k]++;
        }
      }
    }
    return map;
  }, [data, customers, mode]);

  const totalMatch = useMemo(() => {
    if (picked.size === 0 || !data) return null;
    const matchesMode = (active: boolean) =>
      mode === "using" ? active : !active;
    let inAny = 0;
    let inAll = 0;
    for (const c of customers) {
      if (!c.workspace_id) continue;
      const row = data[c.workspace_id];
      const keys = [...picked];
      const hits = keys.filter((k) => matchesMode(Boolean(row?.[k])));
      if (hits.length > 0) inAny++;
      if (hits.length === keys.length) inAll++;
    }
    return { inAny, inAll };
  }, [picked, customers, data, mode]);

  const modeLabel = mode === "using" ? "using" : "not using";

  return (
    <div className="rounded-xl border border-border bg-surface shadow-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface-2 rounded-xl"
      >
        <span className="text-sm font-medium text-fg">
          Feature utilization filter
          {picked.size > 0 ? (
            <span className="ml-2 text-xs text-muted font-normal">
              ({picked.size} selected · {modeLabel} · {combine})
            </span>
          ) : null}
        </span>
        <span
          className={`text-subtle transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ▸
        </span>
      </button>

      {open ? (
        <div className="px-4 py-3 border-t border-border space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Show customers</span>

            <div
              role="radiogroup"
              aria-label="Match mode"
              className="inline-flex rounded-md border border-border overflow-hidden"
            >
              <button
                role="radio"
                aria-checked={mode === "not_using"}
                onClick={() => setMode("not_using")}
                className={`px-2.5 py-1 text-xs ${
                  mode === "not_using"
                    ? "bg-accent text-accent-fg font-medium"
                    : "bg-surface text-muted hover:text-fg"
                }`}
              >
                Not using
              </button>
              <button
                role="radio"
                aria-checked={mode === "using"}
                onClick={() => setMode("using")}
                className={`px-2.5 py-1 text-xs border-l border-border ${
                  mode === "using"
                    ? "bg-accent text-accent-fg font-medium"
                    : "bg-surface text-muted hover:text-fg"
                }`}
              >
                Using
              </button>
            </div>

            <select
              value={combine}
              onChange={(e) => setCombine(e.target.value as Combine)}
              className="px-2 py-0.5 border border-border-strong rounded-md bg-surface text-fg"
              aria-label="Combine mode"
            >
              <option value="any">any of</option>
              <option value="all">all of</option>
            </select>
            <span className="text-muted">the selected features.</span>
            {totalMatch ? (
              <span className="ml-auto text-muted">
                <strong className="text-fg">
                  {combine === "any" ? totalMatch.inAny : totalMatch.inAll}
                </strong>
                /{customers.length} match
              </span>
            ) : null}
          </div>

          {loading ? (
            <div className="text-xs text-muted flex items-center gap-2 py-2">
              <span className="inline-block w-3 h-3 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
              Loading feature utilization for {customers.length} customers…
            </div>
          ) : null}

          {error ? (
            <div className="text-xs text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded p-2">
              {error}
            </div>
          ) : null}

          {FEATURE_GROUPS.map(({ group, keys }) => {
            const allInGroup = keys.every((k) => picked.has(k));
            return (
              <fieldset
                key={group}
                className="border border-border rounded-md p-2"
              >
                <legend className="text-xs text-muted px-1 flex items-center gap-2">
                  <span>{group}</span>
                  <button
                    type="button"
                    onClick={() =>
                      allInGroup ? clearGroup(keys) : selectGroup(keys)
                    }
                    className="text-[11px] text-accent hover:underline"
                  >
                    {allInGroup ? "Clear all" : "Select all"}
                  </button>
                </legend>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                  {keys.map((k) => {
                    const checked = picked.has(k);
                    const count = perFeatureCount?.[k] ?? null;
                    return (
                      <label
                        key={k}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm hover:bg-surface-2 ${
                          checked ? "bg-accent-soft" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(k)}
                          className="h-4 w-4 rounded border-border-strong cursor-pointer flex-shrink-0 accent-[var(--accent)]"
                        />
                        <span className="text-fg break-words flex-1">
                          {FEATURE_BATCH_LABELS[k]}
                        </span>
                        {count != null ? (
                          <span className="text-[11px] text-subtle tabular-nums">
                            {count}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}

          {picked.size > 0 ? (
            <div className="flex">
              <button
                onClick={clear}
                className="text-xs text-accent hover:underline"
              >
                Clear all features
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
