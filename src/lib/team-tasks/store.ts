import { kvGet, kvSet } from "../storage/kv";
import {
  DEFAULT_TEAM_MEMBERS,
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
