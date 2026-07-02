"use client";

import { useEffect, useMemo, useState } from "react";
import {
  FEATURE_BATCH_KEYS,
  FEATURE_BATCH_LABELS,
  type FeatureBatchKey,
  type FeatureBatchMap,
} from "@/lib/engines/feature-utilization-batch";
import { ChipMultiSelect } from "./filters/chip-multi-select";

/** Predicate emitted by the filter — takes a row's workspace_id
 *  (nullable to cover synthesized / off-book rows) and returns
 *  whether it should stay in the visible list. `null` from
 *  onFilterChange means "filter off, keep every row." */
export type WorkspaceFeatureMatcher = (
  workspaceId: string | null | undefined
) => boolean;

interface Props {
  /** Workspace IDs the filter should query feature usage for. Pass
   *  the full unfiltered book's set — the predicate handles per-row
   *  matching, and the batch endpoint dedupes + caches per isolate. */
  workspaceIds: string[];
  /** Called whenever the chip strip / mode / combine changes.
   *  `null` clears the filter — callers should short-circuit and
   *  return every row. */
  onFilterChange: (matcher: WorkspaceFeatureMatcher | null) => void;
  /** Total rows in the caller's list — used for the `N/total match`
   *  hint in the strip header. Defaults to `workspaceIds.length`. */
  totalRowCount?: number;
}

type Combine = "any" | "all";
type Mode = "using" | "not_using";

/**
 * Book-level feature usage filter, chip-strip UX. Matches the At-Risk
 * tab's flag-filter shape: an always-visible chip strip with per-
 * feature counts, plus a Using / Not-using segmented toggle and an
 * any / all combine mode.
 *
 * Design intent: every table view in the app (Customer book, AM
 * cohorts, Renewals) accepts the same predicate contract — a
 * matcher over workspace_id — so each panel can drop this filter
 * in with three lines of glue (a `workspaceIds` array, a matcher
 * state variable, and a `.filter()` call in its rendered list).
 */
export function FeatureUtilizationFilter({
  workspaceIds,
  onFilterChange,
  totalRowCount,
}: Props) {
  const [picked, setPicked] = useState<Set<FeatureBatchKey>>(new Set());
  const [combine, setCombine] = useState<Combine>("any");
  const [mode, setMode] = useState<Mode>("not_using");

  const [data, setData] = useState<FeatureBatchMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable key from the workspace-id set — swaps in a new fetch when
  // the caller re-scopes (e.g. CSM filter narrowed the book). Reference
  // equality of the workspaceIds array is unreliable across re-renders,
  // so we hash the sorted contents to key the effect.
  const workspaceIdsKey = useMemo(() => {
    const dedup = Array.from(new Set(workspaceIds.filter(Boolean))).sort();
    return dedup.join("|");
  }, [workspaceIds]);

  useEffect(() => {
    let cancelled = false;
    const ids = workspaceIdsKey ? workspaceIdsKey.split("|") : [];
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
  }, [workspaceIdsKey]);

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

  // Emit predicate whenever inputs change. Absent-from-batch rows
  // (no workspace_id, or workspace not in the queried set) read as
  // "no usage" — visible only in `not_using` mode.
  useEffect(() => {
    if (picked.size === 0 || !data) {
      onFilterChange(null);
      return;
    }
    const matchesMode = (active: boolean) =>
      mode === "using" ? active : !active;

    const matcher: WorkspaceFeatureMatcher = (workspaceId) => {
      if (!workspaceId) return mode === "not_using";
      const row = data[workspaceId];
      if (combine === "any") {
        for (const k of picked) if (matchesMode(Boolean(row?.[k]))) return true;
        return false;
      }
      for (const k of picked) if (!matchesMode(Boolean(row?.[k]))) return false;
      return true;
    };
    onFilterChange(matcher);
  }, [picked, combine, mode, data, onFilterChange]);

  // Chip counts — "if I picked ONLY this chip, how many rows would
  // match?" Absent-from-batch rows count in `not_using` mode.
  const perFeatureCount = useMemo(() => {
    if (!data) return {} as Record<string, number>;
    const map = {} as Record<string, number>;
    for (const k of FEATURE_BATCH_KEYS) map[k] = 0;
    const ids = workspaceIdsKey ? workspaceIdsKey.split("|") : [];
    for (const id of ids) {
      const row = data[id];
      for (const k of FEATURE_BATCH_KEYS) {
        const active = Boolean(row?.[k]);
        if ((mode === "using" && active) || (mode === "not_using" && !active)) {
          map[k]++;
        }
      }
    }
    return map;
  }, [data, workspaceIdsKey, mode]);

  const totalMatch = useMemo(() => {
    if (picked.size === 0 || !data) return null;
    const matchesMode = (active: boolean) =>
      mode === "using" ? active : !active;
    const ids = workspaceIdsKey ? workspaceIdsKey.split("|") : [];
    let inAny = 0;
    let inAll = 0;
    for (const id of ids) {
      const row = data[id];
      const keys = [...picked];
      const hits = keys.filter((k) => matchesMode(Boolean(row?.[k])));
      if (hits.length > 0) inAny++;
      if (hits.length === keys.length) inAll++;
    }
    return { inAny, inAll };
  }, [picked, workspaceIdsKey, data, mode]);

  const modeLabel = mode === "using" ? "using" : "not using";
  const totalDisplay = totalRowCount ?? (workspaceIdsKey ? workspaceIdsKey.split("|").length : 0);

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
              /{totalDisplay} match
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
