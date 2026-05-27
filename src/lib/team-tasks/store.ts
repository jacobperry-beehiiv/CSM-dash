import { kvGet, kvSet } from "../storage/kv";
import {
  DEFAULT_TEAM_MEMBERS,
  nextAssignmentState,
  type TeamTask,
  type TeamTaskList,
  type TeamMember,
} from "./types";

/**
 * KV-backed read/write for the shared team task list. Reads always hit
 * the store fresh — no module-level cache here so concurrent edits from
 * different CSMs (different Vercel isolates) don't see stale data, the
 * same pitfall we hit on customer overrides earlier.
 *
 * Roster semantics:
 *   - On first-ever read (KV empty) we seed with DEFAULT_TEAM_MEMBERS.
 *   - On every subsequent read the stored list is canonical — no merge
 *     with defaults, so admins can permanently remove someone via
 *     /settings/team without them resurrecting on the next hydrate.
 *   - Tasks' assignment maps stay keyed by member id; an orphaned id
 *     (member removed) just stops rendering. If the member is later
 *     re-added with the same id, their checkbox state comes back.
 */

const KEY = "csm:team-tasks:v1";

function hydrate(stored: Partial<TeamTaskList> | null): TeamTaskList {
  const tasks = (stored?.tasks ?? []) as TeamTask[];
  const members =
    Array.isArray(stored?.members) && stored.members.length > 0
      ? (stored.members as TeamMember[])
      : DEFAULT_TEAM_MEMBERS;
  return { tasks, members };
}

export async function getTeamTasks(): Promise<TeamTaskList> {
  const stored = await kvGet<Partial<TeamTaskList>>(KEY);
  return hydrate(stored);
}

export async function saveTeamTasks(
  next: TeamTaskList
): Promise<TeamTaskList> {
  // Server-side sanity check — drop tasks with no id/ask so we never
  // persist obviously-corrupt rows.
  const cleaned: TeamTaskList = {
    tasks: (next.tasks ?? []).filter(
      (t) => typeof t.id === "string" && t.id.length > 0
    ),
    members:
      Array.isArray(next.members) && next.members.length > 0
        ? next.members
        : DEFAULT_TEAM_MEMBERS,
  };
  await kvSet(KEY, cleaned);
  return cleaned;
}

/**
 * Replace the team roster without disturbing tasks. Reads the latest
 * state, swaps in the new member list, writes back atomically. Used by
 * /settings/team so an admin edit doesn't race with a CSM autosaving
 * task changes from the dashboard.
 */
export async function saveTeamMembers(
  members: TeamMember[]
): Promise<TeamTaskList> {
  const current = await getTeamTasks();
  return saveTeamTasks({ ...current, members });
}

// ─── Atomic op model ────────────────────────────────────────────────
// Each individual mutation (checkbox cycle, text patch, add, delete)
// hits the server as a discrete op rather than writing the whole list
// back from a possibly-stale snapshot. The route does a fresh
// read-modify-write per call so concurrent edits from different CSMs
// merge instead of stomping.

export type TeamTaskOp =
  | { type: "cycle"; taskId: string; memberId: string }
  | { type: "patch"; taskId: string; patch: Partial<TeamTask> }
  | { type: "add"; task: TeamTask }
  | { type: "delete"; taskId: string };

/** Apply a single op to a list, returning the new list. Pure
 *  function — the route does the I/O around it. */
export function applyTeamTaskOp(
  list: TeamTaskList,
  op: TeamTaskOp
): TeamTaskList {
  const now = new Date().toISOString();
  switch (op.type) {
    case "cycle": {
      return {
        ...list,
        tasks: list.tasks.map((t) =>
          t.id !== op.taskId
            ? t
            : {
                ...t,
                assignments: {
                  ...t.assignments,
                  [op.memberId]: nextAssignmentState(
                    t.assignments[op.memberId] ?? "unchecked"
                  ),
                },
                updated_at: now,
              }
        ),
      };
    }
    case "patch": {
      return {
        ...list,
        tasks: list.tasks.map((t) =>
          t.id !== op.taskId ? t : { ...t, ...op.patch, updated_at: now }
        ),
      };
    }
    case "add":
      return { ...list, tasks: [...list.tasks, op.task] };
    case "delete":
      return { ...list, tasks: list.tasks.filter((t) => t.id !== op.taskId) };
  }
}

/** Read current state, apply a batch of ops in order, persist atomically.
 *  Single KV write per request so concurrent calls serialize at the
 *  Postgres layer. */
export async function applyTeamTaskOps(
  ops: TeamTaskOp[]
): Promise<TeamTaskList> {
  let next = await getTeamTasks();
  for (const op of ops) {
    next = applyTeamTaskOp(next, op);
  }
  return saveTeamTasks(next);
}
