/**
 * Shared team-task list — the modal on the CSM mission-control page.
 * Mirrors the spreadsheet workflow Jacob ran in #csm-dream-team-v2: one
 * row per ask, one column per CSM, plus due-date / LOE / priority /
 * details metadata.
 *
 * Types are split from the store so client components can import them
 * without dragging in the Postgres KV (which is Node-only).
 */

export type TaskPriority = "high" | "medium" | "low";

/** Per-member checkbox is tri-state: not yet done, done, or not applicable.
 *  Click the cell to cycle unchecked → checked → na → unchecked. */
export type AssignmentState = "unchecked" | "checked" | "na";

export interface TeamTask {
  id: string;
  ask: string;
  /** ISO date (YYYY-MM-DD). Stored as the raw <input type="date"> value. */
  due_date: string | null;
  /** Level of effort — free text, e.g. "10 mins", "1h", "half a day". */
  loe: string | null;
  priority: TaskPriority | null;
  /** Free-text notes. Plain URLs get auto-linked in the renderer. */
  details: string | null;
  /** Keyed by member.id; defaults to "unchecked" for any missing member. */
  assignments: Record<string, AssignmentState>;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  /** Stable internal ID — never displayed. Used to key assignment rows so
   *  renaming `label` doesn't lose checkbox state. */
  id: string;
  /** Display label shown in the column header. */
  label: string;
  /** Slack user ID (e.g. "U02ABC123") used by the due-date reminder
   *  sweep. When unset, the member is silently skipped — there's no
   *  way to DM them without it. Find a teammate's ID by clicking their
   *  Slack profile → "..." → "Copy member ID". */
  slack_user_id?: string | null;
}

export interface TeamTaskList {
  tasks: TeamTask[];
  members: TeamMember[];
}

/**
 * Default roster for the modal. Edit this list when the team changes —
 * stable `id` values are required so historical assignment data keeps
 * pointing at the right person across label tweaks.
 */
export const DEFAULT_TEAM_MEMBERS: TeamMember[] = [
  { id: "luke", label: "Luke" },
  { id: "mik", label: "Mik" },
  { id: "mac", label: "Mac" },
  { id: "olivia", label: "Olivia" },
  { id: "jacob", label: "Jacob" },
  { id: "jess", label: "Jess" },
  { id: "chris", label: "Chris" },
  { id: "hayden", label: "Hayden" },
];

/**
 * Generate a stable `id` for a new team member from their display label.
 * Lowercased, alphanumerics-and-hyphens only; collisions get a numeric
 * suffix. The id never changes after creation — renaming `label` is
 * free and preserves every existing task's checkbox state.
 */
export function newMemberId(
  label: string,
  existingIds: Iterable<string>
): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "member";
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological fallback — fall back to a random suffix.
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Cycle a single cell through unchecked → checked → na → unchecked. */
export function nextAssignmentState(current: AssignmentState): AssignmentState {
  if (current === "unchecked") return "checked";
  if (current === "checked") return "na";
  return "unchecked";
}

/** A task counts as complete when every member is either checked or N/A
 *  AND at least one member is checked. Anything still unchecked means
 *  someone owes work. */
export function isTaskComplete(
  task: TeamTask,
  members: TeamMember[]
): boolean {
  let hasChecked = false;
  for (const m of members) {
    const state = task.assignments[m.id] ?? "unchecked";
    if (state === "unchecked") return false;
    if (state === "checked") hasChecked = true;
  }
  return hasChecked;
}
