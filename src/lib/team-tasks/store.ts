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
 */

const KEY = "csm:team-tasks:v1";

/** Hydrate stored data, backfilling new fields and merging the latest
 *  default roster so newly-added team members appear as fresh columns. */
function hydrate(stored: Partial<TeamTaskList> | null): TeamTaskList {
  const tasks = (stored?.tasks ?? []) as TeamTask[];
  // Merge the default roster with whatever was stored, preserving any
  // custom labels/ids that came in via writes. Stored members win on id
  // collision so we don't clobber a renamed label.
  const byId = new Map<string, TeamMember>();
  for (const m of DEFAULT_TEAM_MEMBERS) byId.set(m.id, m);
  for (const m of stored?.members ?? []) byId.set(m.id, m);
  return {
    tasks,
    members: [...byId.values()],
  };
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
