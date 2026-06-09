/**
 * Feature request board — surfaces team-submitted suggestions for the
 * dashboard with up/down voting and manual reordering so the team can
 * sort by both democratic signal (votes) and roadmap intent (rank).
 *
 * Storage is a single KV row at csm:feature-requests:v1, packed the
 * same way as team-tasks so the atomic-ops PATCH path keeps concurrent
 * edits from stomping. Client-safe types split into this file; the
 * Postgres KV access lives in ./store.ts.
 */

export type FeatureRequestPriority = "high" | "medium" | "low";

export type FeatureRequestStatus =
  | "open"
  | "in_progress"
  | "shipped"
  | "declined";

export interface FeatureRequest {
  id: string;
  description: string;
  /** Free-text "submitter / CSM" label. Defaults to the viewer's
   *  humanized CSM name when known, but can be edited (e.g. when a
   *  CSM enters a request on behalf of an AM). */
  submitter: string;
  /** Authoritative ownership — the @beehiiv.com email that POSTed
   *  the create op. Used for "edit/delete your own" gating, NOT
   *  shown unless you hover the row's metadata. */
  submitter_email: string;
  priority: FeatureRequestPriority;
  status: FeatureRequestStatus;
  /** One vote per voter (keyed by @beehiiv.com email). The count
   *  shown in the UI is votes.length. Re-voting toggles in/out. */
  votes: string[];
  /** Lower = higher priority in the manual ordering. Server assigns
   *  an integer at create time and the reorder op moves it. Ties
   *  fall back to (votes desc, created_at desc). */
  rank: number;
  created_at: string;
  updated_at: string;
}

export interface FeatureRequestList {
  requests: FeatureRequest[];
}

export type FeatureRequestOp =
  | { type: "add"; request: FeatureRequest }
  | {
      type: "patch";
      requestId: string;
      patch: Partial<
        Pick<FeatureRequest, "description" | "priority" | "status" | "submitter">
      >;
    }
  | { type: "vote"; requestId: string; voterEmail: string }
  | { type: "unvote"; requestId: string; voterEmail: string }
  | { type: "delete"; requestId: string }
  | {
      type: "reorder";
      /** Ordered list of request IDs from top (rank=0) to bottom.
       *  Anything missing keeps its current rank but gets bumped to
       *  the end so partial reorders don't lose rows. */
      orderedIds: string[];
    };

/** Stable 12-char id. Same shape as newTodoId / newTaskId so it
 *  reads consistently in logs. */
export function newRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const stamp = (Date.now() % 1_000_000).toString(36);
  return `fr_${stamp}${rand}`;
}

/** Sort helper used by both the engine and the panel — manual rank
 *  wins; ties go to votes desc, then created_at desc so newer
 *  high-vote items beat older ones at the same rank. */
export function sortRequests(list: FeatureRequest[]): FeatureRequest[] {
  return [...list].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.votes.length !== b.votes.length)
      return b.votes.length - a.votes.length;
    return b.created_at.localeCompare(a.created_at);
  });
}

export const PRIORITY_LABEL: Record<FeatureRequestPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const STATUS_LABEL: Record<FeatureRequestStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  shipped: "Shipped",
  declined: "Declined",
};
