"use client";

import { useState } from "react";
import type {
  ReviewState,
  ReviewStatesMap,
  ReviewWorkflow,
} from "@/lib/data/review-states-types";

/**
 * Bulk-update bar that maps to the same actions as the per-row
 * ReviewStateCell — Reach out / Skip / Done / Clear — but applied
 * to every workspace_id in the selection set in a single PATCH.
 *
 * Renders nothing when nothing is selected; lets the panel slot it
 * unconditionally without juggling visibility itself.
 *
 * Color register matches the per-row dropdown so a CSM doing both
 * single + bulk in the same session has consistent UI:
 *   reach_out — amber
 *   skip      — slate
 *   done      — emerald
 *   clear     — neutral surface
 */

const BUTTONS: Array<{
  label: string;
  state: ReviewState | null;
  className: string;
}> = [
  {
    label: "Reach out",
    state: "reach_out",
    className:
      "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200 border-amber-300 dark:border-amber-500/40 hover:bg-amber-200 dark:hover:bg-amber-500/30",
  },
  {
    label: "Skip",
    state: "skip",
    className:
      "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200 border-slate-300 dark:border-slate-500/40 hover:bg-slate-200 dark:hover:bg-slate-500/30",
  },
  {
    label: "Done",
    state: "done",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200 border-emerald-300 dark:border-emerald-500/40 hover:bg-emerald-200 dark:hover:bg-emerald-500/30",
  },
  {
    label: "Clear",
    state: null,
    className:
      "bg-surface text-fg border-border hover:bg-canvas/40",
  },
];

export function BulkReviewStateActions({
  workspaceIds,
  workflow,
  onApplied,
}: {
  workspaceIds: string[];
  workflow: ReviewWorkflow;
  /** Called with the fresh map after a successful PATCH so the parent
   *  can update its local cache + re-run the ?needs_review filter
   *  without a page refresh. */
  onApplied: (next: ReviewStatesMap) => void;
}) {
  const [busy, setBusy] = useState<ReviewState | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (workspaceIds.length === 0) return null;

  async function apply(state: ReviewState | null) {
    setBusy(state ?? "clear");
    setError(null);
    try {
      const r = await fetch("/api/review-states", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_ids: workspaceIds,
          workflow,
          state,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        map?: ReviewStatesMap;
      };
      if (!r.ok || !j.ok || !j.map) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      onApplied(j.map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] text-muted mr-1">
        Mark {workspaceIds.length}:
      </span>
      {BUTTONS.map((b) => {
        const key = b.state ?? "clear";
        const isBusy = busy === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => void apply(b.state)}
            disabled={busy !== null}
            className={`px-2 py-1 text-xs border rounded-md disabled:opacity-50 ${b.className}`}
          >
            {isBusy ? "…" : b.label}
          </button>
        );
      })}
      {error ? (
        <span className="text-[11px] text-red-700 dark:text-red-300 ml-1">
          {error}
        </span>
      ) : null}
    </div>
  );
}
