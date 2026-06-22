"use client";

import { useEffect, useState } from "react";
import { CollapsibleSection } from "../collapsible-section";
import { fmtDate } from "../format";
import { ReviewStateCell } from "./review-state-cell";
import type {
  ReviewState,
  ReviewStatesMap,
  ReviewWorkflow,
  WorkspaceReviewStates,
} from "@/lib/data/review-states-types";

/**
 * Inline editor for the per-workflow review state (Reach out / Skip /
 * Done / Needs review) on a single customer. Powers the "Review state"
 * section in CustomerDetailPanel so a CSM can fix a mistake from any
 * tab without first navigating to the tab that owns that workflow.
 *
 * The endpoint and dropdown match the ones the per-row cell uses on
 * the AM tabs — only the layout differs (three rows, vertical, with
 * the set-by/set-at metadata next to each dropdown instead of in a
 * tooltip).
 *
 * Lazy-loads /api/review-states on first render. The map is workspace-
 * indexed so we filter down to just this customer's entry; refetching
 * after a dropdown change isn't necessary because ReviewStateCell's
 * onChange already updates our local copy.
 */

interface Props {
  workspaceId: string;
}

const WORKFLOW_LABELS: Record<ReviewWorkflow, string> = {
  past_due: "Past Due",
  proactive: "Proactive Outreach",
  renewals: "Renewals",
};

const WORKFLOWS: ReviewWorkflow[] = ["past_due", "proactive", "renewals"];

export function ReviewStatesSection({ workspaceId }: Props) {
  const [states, setStates] = useState<WorkspaceReviewStates | undefined>(
    undefined
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/review-states")
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as ReviewStatesMap;
      })
      .then((map) => {
        if (cancelled) return;
        setStates(map[workspaceId]);
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
  }, [workspaceId]);

  // Mutate our local copy when the user changes a dropdown. Same
  // map shape as /api/review-states so the next render's display
  // (label, set_by, set_at) matches the persisted value.
  function applyChange(workflow: ReviewWorkflow, next: ReviewState | null) {
    setStates((prev) => {
      const current = prev ?? {};
      if (next === null) {
        const { [workflow]: _omit, ...rest } = current;
        // Empty entry — treat as "no states set" so the parent
        // tooltips render the default copy.
        return Object.keys(rest).length > 0
          ? (rest as WorkspaceReviewStates)
          : undefined;
      }
      return {
        ...current,
        [workflow]: {
          state: next,
          set_at: new Date().toISOString(),
          set_by: null,
        },
      };
    });
  }

  // Headline count is "needs review across all workflows" so the
  // section's trailing chip mirrors the per-row indicator on the
  // tabs. Skip / done / reach_out all count as "decided"; missing
  // entries count as "needs review" — same semantics as needsReview().
  const headline = (() => {
    if (loading || error) return null;
    const decided = WORKFLOWS.filter((w) => states?.[w]?.state).length;
    return (
      <span className="text-[10px] text-subtle">
        {decided}/{WORKFLOWS.length} decided
      </span>
    );
  })();

  return (
    <CollapsibleSection title="Review state" trailing={headline}>
      {loading ? (
        <div className="text-xs text-muted">Loading…</div>
      ) : error ? (
        <div className="text-xs text-red-700 dark:text-red-300">
          Could not load review states: {error}
        </div>
      ) : (
        <div className="space-y-2">
          {WORKFLOWS.map((w) => {
            const entry = states?.[w];
            return (
              <div
                key={w}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-medium text-fg">
                    {WORKFLOW_LABELS[w]}
                  </span>
                  <span className="text-[11px] text-subtle">
                    {entry
                      ? `Set ${fmtDate(entry.set_at)}${
                          entry.set_by ? ` by ${entry.set_by}` : ""
                        }`
                      : "Needs review"}
                  </span>
                </div>
                <div className="w-44 flex-shrink-0">
                  <ReviewStateCell
                    workspaceId={workspaceId}
                    workflow={w}
                    current={states}
                    onChange={(next) => applyChange(w, next)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}
