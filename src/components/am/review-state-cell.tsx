"use client";

import { useState } from "react";
import type {
  ReviewState,
  ReviewWorkflow,
  WorkspaceReviewStates,
} from "@/lib/data/review-states-types";
import { fmtDate } from "../format";

/**
 * Per-row "reach out / skip / done" dropdown shared across Past Due,
 * Proactive Outreach, and Renewals. POSTs the chosen state to
 * /api/review-states for the (workspace_id, workflow) pair.
 *
 * Color register matches the rest of the dashboard's status chips:
 *   reach_out — amber  (action needed)
 *   skip      — slate  (intentional pass)
 *   done      — emerald (handled)
 *   null/empty — neutral surface ("needs review")
 *
 * The dropdown is the source of truth — the digest engine (Phase B)
 * also reads from /api/review-states to count "review needed"
 * per CSM per workflow.
 */

const STATE_LABELS: Record<ReviewState, string> = {
  reach_out: "Reach out",
  skip: "Skip",
  done: "Done",
};

const STATE_CLASSES: Record<ReviewState, string> = {
  reach_out:
    "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200 border-amber-300 dark:border-amber-500/40",
  skip: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200 border-slate-300 dark:border-slate-500/40",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200 border-emerald-300 dark:border-emerald-500/40",
};

interface Props {
  workspaceId: string | null | undefined;
  workflow: ReviewWorkflow;
  /** Current value from the loaded review-states map. Pass undefined
   *  to render the default "needs review" appearance. */
  current: WorkspaceReviewStates | undefined;
  /** Called after a successful POST so the parent can update its
   *  local cache + drive the ?needs_review filter without a page
   *  refresh. */
  onChange: (next: ReviewState | null) => void;
}

export function ReviewStateCell({
  workspaceId,
  workflow,
  current,
  onChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = current?.[workflow];
  const value = entry?.state ?? "";

  async function commit(next: ReviewState | null) {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/review-states", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          workflow,
          state: next,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  if (!workspaceId) {
    return <span className="text-xs text-subtle italic">—</span>;
  }

  const colorCls = entry
    ? STATE_CLASSES[entry.state]
    : "bg-surface border-border-strong text-muted";

  return (
    <div onClick={(e) => e.stopPropagation()} className="space-y-0.5">
      <select
        value={value}
        onChange={(e) => commit((e.target.value || null) as ReviewState | null)}
        disabled={busy}
        title={
          entry
            ? `${STATE_LABELS[entry.state]} — set ${fmtDate(entry.set_at)}${
                entry.set_by ? ` by ${entry.set_by}` : ""
              }`
            : "Mark whether you plan to reach out about this account."
        }
        className={`w-full px-2 py-1 text-xs rounded-md border font-medium ${colorCls}`}
      >
        <option value="">Needs review</option>
        <option value="reach_out">{STATE_LABELS.reach_out}</option>
        <option value="skip">{STATE_LABELS.skip}</option>
        <option value="done">{STATE_LABELS.done}</option>
      </select>
      {error ? (
        <div className="text-[10px] text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
