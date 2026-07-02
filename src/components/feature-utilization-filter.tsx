"use client";

import { useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import {
  FEATURE_BATCH_KEYS,
  FEATURE_BATCH_LABELS,
  type FeatureBatchKey,
  type FeatureBatchMap,
} from "@/lib/engines/feature-utilization-batch";
import { ChipMultiSelect } from "./filters/chip-multi-select";

interface Props {
  customers: Customer[];
  /** Called whenever the filter changes. `null` clears the filter. */
  onFilterChange: (predicate: ((c: Customer) => boolean) | null) => void;
}

type Combine = "any" | "all";
type Mode = "using" | "not_using";

/**
 * Book-level feature filter, chip-strip UX.
 *
 * Matches the At-Risk tab's flag-filter pattern: an always-visible chip
 * strip with per-feature counts, plus a Using / Not-using segmented
 * toggle and an any / all combine mode. Clicking a chip toggles it on.
 * The batch fetch (one Postgres trip for every workspace_id in the
 * book) fires on mount so the chip counts show up without another
 * click. Cached in-process for the isolate lifetime.
 *
 * Predicate emission is on every input change — same contract as
 * before, so `customer-table.tsx` doesn't need to change how it
 * consumes this filter.
 */
export function FeatureUtilizationFilter({ customers, onFilterChange }: Props) {
  const [picked, setPicked] = useState<Set<FeatureBatchKey>>(new Set());
  const [combine, setCombine] = useState<Combine>("any");
  const [mode, setMode] = useState<Mode>("not_using");

  const [data, setData] = useState<FeatureBatchMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch on mount so chip counts populate without an extra click.
  // Depends on customers.length so a swap of the book (e.g. CSM
  // filter re-scoped the list) re-fetches against the new IDs.
  useEffect(() => {
    let cancelled = false;
    const ids = customers
      .map((c) => c.workspace_id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      setData({});
      return;
    }
    setLoading(true);
    setError(null);
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
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customers]);

  function toggle(key: FeatureBatchKey) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clear() {
    setPicked(new Set());
  }

  // Emit predicate whenever inputs change. Same semantics as before —
  // "using" matches active-in-batch, "not_using" is the inverse. A
  // customer missing from the batch (unenrolled / no workspace_id)
  // reads as "no usage" so they show up in not_using mode.
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

  // Per-feature count — how many customers would match this ONE
  // chip in the current mode. Drives the chip's little number badge.
  const perFeatureCount = useMemo(() => {
    if (!data) return {} as Record<string, number>;
    const map = {} as Record<string, number>;
    for (const k of FEATURE_BATCH_KEYS) map[k] = 0;
    for (const c of customers) {
      if (!c.workspace_id) {
        if (mode === "not_using") {
          for (const k of FEATURE_BATCH_KEYS) map[k]++;
        }
        continue;
      }
      const row = data[c.workspace_id];
      for (const k of FEATURE_BATCH_KEYS) {
        const active = Boolean(row?.[k]);
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
      let hits = 0;
      const keys = [...picked];
      if (!c.workspace_id) {
        // Absent from the batch reads as inactive for every feature.
        hits = mode === "not_using" ? keys.length : 0;
      } else {
        const row = data[c.workspace_id];
        for (const k of keys) if (matchesMode(Boolean(row?.[k]))) hits++;
      }
      if (hits > 0) inAny++;
      if (hits === keys.length) inAll++;
    }
    return { inAny, inAll };
  }, [picked, customers, data, mode]);

  const modeLabel = mode === "using" ? "using" : "not using";

  return (
    <div className="rounded-xl border border-border bg-surface shadow-card px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-sm font-medium text-fg">Feature usage</span>
        <span className="text-muted">— show customers</span>

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

        {picked.size > 0 ? (
          <button
            onClick={clear}
            className="text-[11px] text-accent hover:underline ml-2"
          >
            Clear ({picked.size} selected · {modeLabel})
          </button>
        ) : null}

        <span className="ml-auto text-muted">
          {loading ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
              Loading feature signals…
            </span>
          ) : totalMatch ? (
            <>
              <strong className="text-fg tabular-nums">
                {combine === "any" ? totalMatch.inAny : totalMatch.inAll}
              </strong>
              /{customers.length} match
            </>
          ) : (
            <span className="text-subtle">
              no features selected — filter off
            </span>
          )}
        </span>
      </div>

      {error ? (
        <div className="text-xs text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded p-2">
          {error}
        </div>
      ) : null}

      <ChipMultiSelect
        options={FEATURE_BATCH_KEYS.map((k) => ({
          value: k,
          label: FEATURE_BATCH_LABELS[k],
          description: `${
            mode === "using" ? "Currently using" : "Not using"
          } ${FEATURE_BATCH_LABELS[k]}`,
        }))}
        selected={picked}
        onToggle={toggle}
        countMap={perFeatureCount}
        // Don't dim empty options — a zero-count chip is a valid
        // signal ("nobody in this book uses MCP") and clicking it
        // should still be allowed to lock the filter to that state.
        disableZeroCounts={false}
      />
    </div>
  );
}
