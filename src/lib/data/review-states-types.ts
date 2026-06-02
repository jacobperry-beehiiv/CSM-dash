/**
 * Client-safe types + pure helpers for the per-workflow review state.
 *
 * Mirrors the past-due-history-types.ts pattern — review-states.ts
 * itself imports the KV layer (Postgres / fs) and can't be pulled
 * into client bundles. Components import shapes + the `needsReview`
 * predicate from here instead.
 */

export type ReviewWorkflow = "past_due" | "proactive" | "renewals";
export type ReviewState = "reach_out" | "skip" | "done";

export interface ReviewStateEntry {
  state: ReviewState;
  set_at: string;
  set_by: string | null;
  note?: string | null;
}

export interface WorkspaceReviewStates {
  past_due?: ReviewStateEntry;
  proactive?: ReviewStateEntry;
  renewals?: ReviewStateEntry;
}

export type ReviewStatesMap = Record<string, WorkspaceReviewStates>;

export const REVIEW_WORKFLOWS: ReviewWorkflow[] = [
  "past_due",
  "proactive",
  "renewals",
];

export const REVIEW_STATES: ReviewState[] = ["reach_out", "skip", "done"];

/** Does this workspace need review for `workflow`? Returns true when
 *  the state is "reach_out" OR not set (default = needs review).
 *  False only when explicitly "skip" or "done". */
export function needsReview(
  states: WorkspaceReviewStates | undefined,
  workflow: ReviewWorkflow
): boolean {
  const entry = states?.[workflow];
  if (!entry) return true;
  return entry.state === "reach_out";
}
