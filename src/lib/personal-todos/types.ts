/**
 * Personal to-do lists — per-CSM, populated three ways:
 *   1. Manually (typed into the panel on the home page).
 *   2. Auto from one-time future-dated entries (surface_at in the
 *      future → dormant until that date hits).
 *   3. By the Slack bot (slash command / DM / reaction emoji).
 *
 * Types live in their own module — client-safe, no Node imports —
 * mirroring the team-tasks split. The store + reminder code stays
 * server-only in sibling files.
 */

export type TodoPriority = "high" | "medium" | "low";

/** How this row was created. The UI renders a small badge per source
 *  so the CSM knows where it came from. */
export type TodoSource =
  | "manual"
  | "slack_slash"
  | "slack_dm"
  | "slack_reaction"
  | "scheduled";

/** Slack-side provenance carried on rows created from Slack. Filled in
 *  by the inbound webhook so the UI can render a "↗ View in Slack"
 *  permalink and so the sweep can replay context if needed. */
export interface SlackSourceMeta {
  slack_user_id?: string;
  slack_channel_id?: string;
  slack_message_ts?: string;
  slack_permalink?: string;
  /** For DM / reaction sources: the original message text we extracted
   *  the title from. Persisted so the UI can show "via DM: …" without
   *  hitting Slack again. */
  original_text?: string;
}

export interface PersonalTodo {
  id: string;
  /** The thing to do. Required, ≥1 char on creation. */
  title: string;
  /** Free-text notes / link / context. Plain URLs auto-linkified in the
   *  panel. Optional. */
  details: string | null;
  /** ISO YYYY-MM-DD — when the work is due. Drives the 4-stage Slack
   *  reminder ladder (3d / 1d / 0d / 3d-overdue) shared with team-tasks. */
  due_date: string | null;
  /** ISO YYYY-MM-DD — when the row should *appear* in the active list.
   *  When null OR <= today, the row is active immediately. When in the
   *  future, the row is dormant and hidden behind a "Scheduled (N)"
   *  collapsed section. The sweep flips it to active on or after the
   *  date + DMs the owner one activation reminder. */
  surface_at: string | null;
  priority: TodoPriority | null;
  source: TodoSource;
  /** Provenance for Slack-created rows. Null for manual / scheduled. */
  source_meta: SlackSourceMeta | null;
  /** ISO timestamp when the todo was marked complete; null = open. */
  completed_at: string | null;
  /** Opt-in for the daily due-date Slack reminder ladder (3d / 1d / 0d
   *  / 3d-overdue). Defaults to true when undefined for back-compat
   *  with rows created before the field existed. The sweep treats
   *  `false` as "silent tracker" and skips ALL reminder stages; the
   *  surface_at activation DM (which only fires once when a scheduled
   *  todo becomes active) still runs regardless. */
  remind_via_slack?: boolean;
  created_at: string;
  updated_at: string;
}

/** Treat undefined / true as "remind me." Centralized so the sweep,
 *  the UI, and the Slack views all interpret the field the same way. */
export function shouldRemindViaSlack(todo: PersonalTodo): boolean {
  return todo.remind_via_slack !== false;
}

/**
 * Top-level KV value at `csm:personal-todos:v1`. All users packed into
 * one row so the sweep reads everything in a single shot — same
 * trade-off as team-tasks, fine at our scale (a handful of CSMs).
 */
export interface PersonalTodosState {
  /** Keyed by user identity key (see lib/personal-todos/identity.ts).
   *  Each slice is the user's complete todo list. */
  by_user: Record<string, { todos: PersonalTodo[] }>;
}

export const EMPTY_STATE: PersonalTodosState = { by_user: {} };

/** Op shapes mutate exactly one row at a time. Server applies them in
 *  order under a fresh read-modify-write per request so concurrent
 *  PATCHes don't stomp each other (mirrors the team-tasks pattern). */
export type PersonalTodoOp =
  | { type: "add"; todo: PersonalTodo }
  | { type: "patch"; todoId: string; patch: Partial<PersonalTodo> }
  | { type: "toggle_complete"; todoId: string }
  | { type: "delete"; todoId: string };

/** Stable random + timestamp id. Same shape as team-tasks. */
export function newTodoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** "Is this todo's surface date in the future?" — surface_at is
 *  YYYY-MM-DD; we compare as dates so timezones don't shift it by a
 *  day. Pass today's YMD (UTC) for stable cross-isolate behavior. */
export function isScheduledFor(
  todo: PersonalTodo,
  todayYmd: string
): boolean {
  if (!todo.surface_at) return false;
  return todo.surface_at > todayYmd;
}

/** Build today's YYYY-MM-DD in UTC. Reminders and surface activation
 *  compare against this so the cron's TZ doesn't shift outcomes. */
export function todayYmdUtc(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
