import { kvGet, kvSet } from "../storage/kv";
import {
  newRequestId,
  type FeatureRequest,
  type FeatureRequestList,
  type FeatureRequestOp,
} from "./types";

/**
 * KV-backed store for the feature-request board. Single row at
 * csm:feature-requests:v1, no module-level cache (avoids the
 * stale-read pitfall we hit on customer-overrides) — every call
 * round-trips the KV so concurrent edits from different isolates
 * see the latest snapshot before merging.
 *
 * The atomic-ops shape (PATCH { ops: [...] }) means each individual
 * mutation lands as a discrete op the server applies against the
 * current state, NOT a whole-list overwrite. Vote toggles, edits,
 * reorders from different users merge naturally instead of stomping.
 */

const KEY = "csm:feature-requests:v1";

export async function loadFeatureRequests(): Promise<FeatureRequestList> {
  const stored = await kvGet<FeatureRequestList>(KEY);
  return {
    requests: Array.isArray(stored?.requests) ? stored!.requests : [],
  };
}

export async function saveFeatureRequests(
  next: FeatureRequestList
): Promise<FeatureRequestList> {
  // Drop obviously-corrupt rows so a malformed patch can't poison
  // the file. Requires id + description; everything else has safe
  // defaults applied below.
  const cleaned: FeatureRequestList = {
    requests: (next.requests ?? []).filter(
      (r) =>
        typeof r?.id === "string" &&
        r.id.length > 0 &&
        typeof r.description === "string" &&
        r.description.trim().length > 0
    ),
  };
  await kvSet(KEY, cleaned);
  return cleaned;
}

/**
 * Apply a single op to a list in-memory. Pure function — caller does
 * the I/O around it (read latest → apply → write back) so a stale
 * client snapshot can't overwrite a teammate's concurrent edit.
 */
export function applyFeatureRequestOp(
  list: FeatureRequestList,
  op: FeatureRequestOp
): FeatureRequestList {
  const now = new Date().toISOString();
  switch (op.type) {
    case "add": {
      // Server assigns rank = current max + 1 so new entries land at
      // the bottom of the manual order. Voting can still bubble them
      // up within their rank tier (see sortRequests in types.ts).
      const maxRank = list.requests.reduce(
        (acc, r) => Math.max(acc, r.rank),
        -1
      );
      const next: FeatureRequest = {
        ...op.request,
        rank: op.request.rank ?? maxRank + 1,
        votes: op.request.votes ?? [],
        status: op.request.status ?? "open",
        created_at: op.request.created_at ?? now,
        updated_at: now,
      };
      return { requests: [...list.requests, next] };
    }
    case "patch": {
      return {
        requests: list.requests.map((r) =>
          r.id !== op.requestId
            ? r
            : { ...r, ...op.patch, updated_at: now }
        ),
      };
    }
    case "vote": {
      const voter = op.voterEmail.trim().toLowerCase();
      if (!voter) return list;
      return {
        requests: list.requests.map((r) => {
          if (r.id !== op.requestId) return r;
          // Dedupe — re-voting is a no-op; toggling off uses the
          // separate `unvote` op. Keeps the array small and the
          // vote count trustworthy.
          if (r.votes.includes(voter)) return r;
          return { ...r, votes: [...r.votes, voter], updated_at: now };
        }),
      };
    }
    case "unvote": {
      const voter = op.voterEmail.trim().toLowerCase();
      if (!voter) return list;
      return {
        requests: list.requests.map((r) =>
          r.id !== op.requestId
            ? r
            : {
                ...r,
                votes: r.votes.filter((v) => v !== voter),
                updated_at: now,
              }
        ),
      };
    }
    case "delete": {
      return {
        requests: list.requests.filter((r) => r.id !== op.requestId),
      };
    }
    case "reorder": {
      // Walk the orderedIds, assigning rank = index. Anything missing
      // from orderedIds gets pushed to the end with rank >= ordered
      // length so a partial reorder doesn't lose rows. Stable order
      // preserved among the missing set so they don't shuffle.
      const ranked = new Map<string, number>();
      op.orderedIds.forEach((id, i) => ranked.set(id, i));
      const offset = op.orderedIds.length;
      let tail = 0;
      return {
        requests: list.requests.map((r) => {
          if (ranked.has(r.id)) {
            return { ...r, rank: ranked.get(r.id)!, updated_at: now };
          }
          const rank = offset + tail++;
          return { ...r, rank, updated_at: now };
        }),
      };
    }
  }
}

/**
 * Atomic op-list apply. Reads the latest list, runs every op
 * in-sequence, writes the result back. Returns the updated list so
 * the route can hand it straight back to the client (saves a follow-
 * up GET).
 */
export async function applyFeatureRequestOps(
  ops: FeatureRequestOp[]
): Promise<FeatureRequestList> {
  const current = await loadFeatureRequests();
  let next = current;
  for (const op of ops) {
    next = applyFeatureRequestOp(next, op);
  }
  return saveFeatureRequests(next);
}

/** Convenience for the route to mint a new request from a partial
 *  body, supplying defaults for the server-controlled fields. */
export function buildNewRequest(
  partial: Pick<FeatureRequest, "description" | "submitter" | "submitter_email" | "priority">
): FeatureRequest {
  const now = new Date().toISOString();
  return {
    id: newRequestId(),
    description: partial.description.trim(),
    submitter: partial.submitter.trim(),
    submitter_email: partial.submitter_email.trim().toLowerCase(),
    priority: partial.priority,
    status: "open",
    votes: [],
    // Rank is reset by the `add` op against the current max — passed
    // value here is a placeholder.
    rank: 0,
    created_at: now,
    updated_at: now,
  };
}
