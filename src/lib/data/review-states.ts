import { kvGet, kvSet } from "../storage/kv";
import {
  REVIEW_STATES,
  REVIEW_WORKFLOWS,
  needsReview,
  type ReviewState,
  type ReviewStateEntry,
  type ReviewStatesMap,
  type ReviewWorkflow,
  type WorkspaceReviewStates,
} from "./review-states-types";

/**
 * Per-workflow "should I reach out?" decision a CSM makes about each
 * workspace. Server-only — touches the KV. Client components import
 * shapes + the needsReview predicate from review-states-types.ts
 * instead so the Postgres / fs deps don't end up in the browser
 * bundle (same pattern as past-due-history.ts vs
 * past-due-history-types.ts).
 */

// Re-export the types so existing server-side consumers keep their
// `import { … } from "./review-states"` paths unchanged.
export {
  REVIEW_STATES,
  REVIEW_WORKFLOWS,
  needsReview,
  type ReviewState,
  type ReviewStateEntry,
  type ReviewStatesMap,
  type ReviewWorkflow,
  type WorkspaceReviewStates,
};

const KEY = "csm:review-states:v1";

export async function loadReviewStates(): Promise<ReviewStatesMap> {
  return (await kvGet<ReviewStatesMap>(KEY)) ?? {};
}

/** Set or clear a single workflow's review state for a workspace.
 *  Pass `state = null` to clear back to needs-review (deletes the
 *  entry for that workflow). When the workspace has no remaining
 *  workflows tracked, the whole workspace row drops out of the map
 *  so we don't accumulate empty objects. */
export async function setReviewState(
  workspaceId: string,
  workflow: ReviewWorkflow,
  state: ReviewState | null,
  meta: { setBy?: string | null; note?: string | null } = {}
): Promise<ReviewStatesMap> {
  const map = { ...(await loadReviewStates()) };
  const current: WorkspaceReviewStates = { ...(map[workspaceId] ?? {}) };

  if (state === null) {
    delete current[workflow];
  } else {
    current[workflow] = {
      state,
      set_at: new Date().toISOString(),
      set_by: meta.setBy ?? null,
      note: meta.note ?? null,
    };
  }

  if (Object.keys(current).length === 0) {
    delete map[workspaceId];
  } else {
    map[workspaceId] = current;
  }
  await kvSet(KEY, map);
  return map;
}
