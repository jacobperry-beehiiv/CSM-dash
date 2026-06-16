import { kvGet, kvSet } from "../storage/kv";
import {
  EMPTY_STATE,
  type PersonalTodo,
  type PersonalTodoOp,
  type PersonalTodosState,
} from "./types";

/**
 * KV-backed read/write for personal todos. The full multi-user state
 * lives at a single KV key (`csm:personal-todos:v1`) — same pattern as
 * team-tasks — so the sweep can read everything in one shot. Each user
 * has their own slice under `state.by_user[userKey]` so handlers
 * touching one user never see another user's rows.
 *
 * Concurrency: every mutation is a fresh read-modify-write. Postgres
 * KV's INSERT … ON CONFLICT serializes writes per key so concurrent
 * PATCH calls merge cleanly. Reads always hit the store; no
 * module-level cache here so different Vercel isolates can't drift.
 */

const KEY = "csm:personal-todos:v1";

export async function loadAll(): Promise<PersonalTodosState> {
  const stored = await kvGet<Partial<PersonalTodosState>>(KEY);
  return { by_user: stored?.by_user ?? {} };
}

async function saveAll(next: PersonalTodosState): Promise<void> {
  await kvSet(KEY, next);
}

/** Get a single user's todo list. Returns an empty array when the user
 *  has no slice yet — callers never have to handle undefined. */
export async function getTodosForUser(userKey: string): Promise<PersonalTodo[]> {
  const all = await loadAll();
  return all.by_user[userKey]?.todos ?? [];
}

/**
 * Apply one op to a user's slice. Pure function — the store function
 * below does the I/O around it.
 *
 * `audit` (optional): when provided, the op stamps source_meta with
 * `admin_acted_by` + `admin_acted_at` so the UI can show "edited by
 * admin: jacob@beehiiv.com" and the owning CSM has a clear trail of
 * who did what. Only set when the op came in via the /admin/team-todos
 * surface — self-edits leave the field untouched.
 */
export interface AdminAudit {
  admin_acted_by: string;
}

export function applyTodoOp(
  todos: PersonalTodo[],
  op: PersonalTodoOp,
  audit?: AdminAudit
): PersonalTodo[] {
  const now = new Date().toISOString();
  const stampAudit = (
    existing: PersonalTodo["source_meta"]
  ): PersonalTodo["source_meta"] => {
    if (!audit) return existing;
    return {
      ...(existing ?? {}),
      admin_acted_by: audit.admin_acted_by,
      admin_acted_at: now,
    };
  };
  switch (op.type) {
    case "add":
      return [
        ...todos,
        audit
          ? { ...op.todo, source_meta: stampAudit(op.todo.source_meta) }
          : op.todo,
      ];
    case "patch":
      return todos.map((t) =>
        t.id !== op.todoId
          ? t
          : {
              ...t,
              ...op.patch,
              source_meta: stampAudit(t.source_meta),
              updated_at: now,
            }
      );
    case "toggle_complete":
      return todos.map((t) =>
        t.id !== op.todoId
          ? t
          : {
              ...t,
              completed_at: t.completed_at ? null : now,
              source_meta: stampAudit(t.source_meta),
              updated_at: now,
            }
      );
    case "delete":
      // Nothing to stamp — the row is gone. Audit of deletes lives
      // elsewhere (the response shows what was removed; we could
      // promote that to a separate audit log later if needed).
      return todos.filter((t) => t.id !== op.todoId);
  }
}

/**
 * Apply a batch of ops to a single user's slice and persist atomically.
 * One KV write per request so concurrent calls serialize at the
 * Postgres layer — and crucially, ops scoped to user A can never
 * stomp user B's slice because we only rewrite A's array.
 */
export async function applyTodoOps(
  userKey: string,
  ops: PersonalTodoOp[],
  audit?: AdminAudit
): Promise<PersonalTodo[]> {
  const all = await loadAll();
  let userTodos = all.by_user[userKey]?.todos ?? [];
  for (const op of ops) {
    userTodos = applyTodoOp(userTodos, op, audit);
  }
  // Drop obvious garbage (id/title required) before persisting — same
  // safety net team-tasks has at saveTeamTasks.
  const cleaned = userTodos.filter(
    (t) =>
      typeof t.id === "string" &&
      t.id.length > 0 &&
      typeof t.title === "string"
  );
  const nextState: PersonalTodosState = {
    ...all,
    by_user: { ...all.by_user, [userKey]: { todos: cleaned } },
  };
  await saveAll(nextState);
  return cleaned;
}

/**
 * Replace the entire state. Used by the sweep when activating multiple
 * scheduled todos in one pass (clearing surface_at across many rows).
 * The sweep is the only legitimate caller of this — UI flows go through
 * applyTodoOps so per-user isolation stays intact.
 */
export async function saveStateForSweep(
  next: PersonalTodosState
): Promise<void> {
  await saveAll(next);
}

// Re-export so route handlers don't have to import from two places.
export { EMPTY_STATE };
