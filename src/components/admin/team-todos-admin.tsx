"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  newTodoId,
  todayYmdUtc,
  isScheduledFor,
  type PersonalTodo,
  type PersonalTodoOp,
  type TodoPriority,
} from "@/lib/personal-todos/types";
import { DoneCheckbox } from "../done-checkbox";
import { TodoCelebration } from "../todo-celebration";

/**
 * Admin-only team to-dos surface, mounted at /admin/team-todos.
 *
 * Two panes:
 *   • Sidebar — every CSM with a userKey or a slot in the customer
 *     book, sorted by open-count desc. Click to select.
 *   • Detail — selected CSM's full to-do list. Active / scheduled /
 *     completed sections. Add new, toggle complete, edit title +
 *     due date, delete. Every mutation goes to
 *     /api/admin/team-todos/<userKey> which stamps the admin's email
 *     onto each row's source_meta.
 *
 * Talks to the dedicated admin endpoints — not the standard
 * /api/personal-todos — so a future regression in the standard path
 * (e.g. session-derived userKey overrides) can't leak into the
 * admin flow.
 */

interface UserSummary {
  userKey: string;
  csm_handle: string | null;
  email: string | null;
  open_count: number;
  scheduled_count: number;
  completed_count: number;
  total_count: number;
}

interface Props {
  viewerEmail: string;
}

export function TeamTodosAdmin({ viewerEmail }: Props) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [todos, setTodos] = useState<PersonalTodo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // ── Load the team summary on mount + every 30s so counts stay
  // roughly fresh while the admin works.
  const refreshSummary = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/team-todos");
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { users: UserSummary[] };
      setUsers(j.users);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
    const interval = window.setInterval(refreshSummary, 30_000);
    return () => window.clearInterval(interval);
  }, [refreshSummary]);

  // ── Load the selected CSM's todos when selection changes.
  const refreshSelected = useCallback(async (userKey: string) => {
    try {
      const r = await fetch(
        `/api/admin/team-todos/${encodeURIComponent(userKey)}`
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { todos: PersonalTodo[] };
      setTodos(j.todos);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load todos");
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setTodos(null);
      return;
    }
    void refreshSelected(selected);
  }, [selected, refreshSelected]);

  // ── Send ops to the admin endpoint. Refreshes the local todo list
  // + the summary so the sidebar counts update too.
  const sendOps = useCallback(
    async (ops: PersonalTodoOp[]) => {
      if (!selected) return;
      try {
        const r = await fetch(
          `/api/admin/team-todos/${encodeURIComponent(selected)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ops }),
          }
        );
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        const j = (await r.json()) as { todos: PersonalTodo[] };
        setTodos(j.todos);
        setSavedAt(new Date().toISOString());
        setWriteError(null);
        // Fire-and-forget summary refresh so counts update in the
        // sidebar without waiting for the next 30s poll.
        void refreshSummary();
      } catch (e) {
        setWriteError(e instanceof Error ? e.message : "Save failed");
      }
    },
    [selected, refreshSummary]
  );

  // ── Composer for adding new todos on a CSM's behalf.
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDueDate, setDraftDueDate] = useState("");
  const [draftPriority, setDraftPriority] = useState<TodoPriority | "">("");
  async function addFromComposer() {
    const title = draftTitle.trim();
    if (!title || !selected) return;
    const now = new Date().toISOString();
    const todo: PersonalTodo = {
      id: newTodoId(),
      title,
      details: null,
      due_date: draftDueDate || null,
      surface_at: null,
      priority: (draftPriority as TodoPriority) || null,
      source: "manual",
      // source_meta will be re-stamped by the server with admin_acted_by,
      // but seed it so the field exists on day one.
      source_meta: { admin_acted_by: viewerEmail },
      completed_at: null,
      remind_via_slack: true,
      created_at: now,
      updated_at: now,
    };
    setDraftTitle("");
    setDraftDueDate("");
    setDraftPriority("");
    await sendOps([{ type: "add", todo }]);
  }

  async function toggleComplete(todoId: string) {
    await sendOps([{ type: "toggle_complete", todoId }]);
  }
  async function patchTodo(todoId: string, patch: Partial<PersonalTodo>) {
    await sendOps([{ type: "patch", todoId, patch }]);
  }
  async function deleteTodo(todoId: string) {
    if (!confirm("Delete this to-do? Can't be undone.")) return;
    await sendOps([{ type: "delete", todoId }]);
  }

  // ── Derived slices: open / scheduled / completed.
  const today = todayYmdUtc();
  const { open, scheduled, completed } = useMemo(() => {
    const o: PersonalTodo[] = [];
    const s: PersonalTodo[] = [];
    const c: PersonalTodo[] = [];
    for (const t of todos ?? []) {
      if (t.completed_at) c.push(t);
      else if (isScheduledFor(t, today)) s.push(t);
      else o.push(t);
    }
    return { open: o, scheduled: s, completed: c };
  }, [todos, today]);

  const selectedSummary = users?.find((u) => u.userKey === selected) ?? null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] gap-4">
      {/* ── Sidebar ── */}
      <aside className="bg-surface border border-border rounded-xl shadow-card overflow-hidden h-fit">
        <header className="px-3 py-2 border-b border-border">
          <h2 className="text-sm font-semibold text-fg">CSMs</h2>
          <p className="text-[11px] text-muted mt-0.5">
            {users ? `${users.length} accounts` : "Loading…"}
          </p>
        </header>
        {loadError && !users ? (
          <p className="px-3 py-3 text-xs text-red-600 dark:text-red-300">
            {loadError}
          </p>
        ) : !users ? (
          <p className="px-3 py-3 text-xs text-muted">Loading…</p>
        ) : (
          <ul className="divide-y divide-border max-h-[70vh] overflow-y-auto">
            {users.map((u) => {
              const active = u.userKey === selected;
              const label =
                u.csm_handle?.replace(/_/g, " ") ?? u.email ?? u.userKey;
              return (
                <li key={u.userKey}>
                  <button
                    type="button"
                    onClick={() => setSelected(u.userKey)}
                    className={`w-full text-left px-3 py-2 hover:bg-canvas/40 transition-colors ${
                      active ? "bg-canvas/60" : ""
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={`text-sm truncate ${active ? "font-semibold text-fg" : "text-fg"}`}
                      >
                        {label}
                      </span>
                      <span className="text-[11px] font-mono text-muted shrink-0">
                        {u.open_count}
                        {u.scheduled_count > 0 ? ` · +${u.scheduled_count}` : ""}
                      </span>
                    </div>
                    {u.email ? (
                      <div className="text-[11px] text-subtle truncate">
                        {u.email}
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* ── Detail ── */}
      <section className="bg-surface border border-border rounded-xl shadow-card overflow-hidden">
        {!selected ? (
          <div className="px-5 py-10 text-center text-sm text-muted">
            Pick a CSM from the sidebar to view their to-dos.
          </div>
        ) : (
          <>
            <header className="px-5 py-3 border-b border-border flex items-baseline justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-fg">
                  {selectedSummary?.csm_handle?.replace(/_/g, " ") ??
                    selectedSummary?.email ??
                    selected}
                </h2>
                <p className="text-xs text-muted mt-0.5">
                  {selectedSummary?.email ?? selected}
                  {" · "}
                  {open.length} open · {scheduled.length} scheduled ·{" "}
                  {completed.length} completed
                </p>
              </div>
              {savedAt ? (
                <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
                  Saved
                </span>
              ) : null}
            </header>

            {writeError ? (
              <div className="px-5 py-2 text-xs text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/30">
                {writeError}
              </div>
            ) : null}

            {/* Composer */}
            <div className="px-5 py-3 bg-canvas/30 border-b border-border">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 min-w-[200px]">
                  <span className="block text-[11px] text-muted mb-1">
                    Add a to-do for this CSM
                  </span>
                  <input
                    type="text"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    placeholder="What needs doing?"
                    className="w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
                  />
                </label>
                <label>
                  <span className="block text-[11px] text-muted mb-1">Due</span>
                  <input
                    type="date"
                    value={draftDueDate}
                    onChange={(e) => setDraftDueDate(e.target.value)}
                    className="px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
                  />
                </label>
                <label>
                  <span className="block text-[11px] text-muted mb-1">
                    Priority
                  </span>
                  <select
                    value={draftPriority}
                    onChange={(e) =>
                      setDraftPriority(e.target.value as TodoPriority | "")
                    }
                    className="px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
                  >
                    <option value="">—</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void addFromComposer()}
                  disabled={!draftTitle.trim()}
                  className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Lists */}
            <TodoSection
              title="Open"
              todos={open}
              emptyText="Nothing on their active list."
              onToggle={(id) => void toggleComplete(id)}
              onPatch={(id, patch) => void patchTodo(id, patch)}
              onDelete={(id) => void deleteTodo(id)}
            />
            {scheduled.length > 0 ? (
              <TodoSection
                title={`Scheduled (${scheduled.length})`}
                todos={scheduled}
                onToggle={(id) => void toggleComplete(id)}
                onPatch={(id, patch) => void patchTodo(id, patch)}
                onDelete={(id) => void deleteTodo(id)}
                muted
              />
            ) : null}
            {completed.length > 0 ? (
              <TodoSection
                title={`Completed (${completed.length})`}
                todos={completed}
                onToggle={(id) => void toggleComplete(id)}
                onPatch={(id, patch) => void patchTodo(id, patch)}
                onDelete={(id) => void deleteTodo(id)}
                muted
              />
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

interface TodoSectionProps {
  title: string;
  todos: PersonalTodo[];
  emptyText?: string;
  onToggle: (todoId: string) => void;
  onPatch: (todoId: string, patch: Partial<PersonalTodo>) => void;
  onDelete: (todoId: string) => void;
  muted?: boolean;
}

function TodoSection({
  title,
  todos,
  emptyText,
  onToggle,
  onPatch,
  onDelete,
  muted,
}: TodoSectionProps) {
  return (
    <div className={muted ? "opacity-90" : ""}>
      <div className="px-5 py-2 border-t border-border bg-canvas/20 text-xs font-medium uppercase tracking-wide text-muted">
        {title}
      </div>
      {todos.length === 0 ? (
        emptyText ? (
          <p className="px-5 py-3 text-sm text-muted">{emptyText}</p>
        ) : null
      ) : (
        <ul className="divide-y divide-border">
          {todos.map((t) => (
            <TodoRow
              key={t.id}
              todo={t}
              onToggle={() => onToggle(t.id)}
              onPatch={(patch) => onPatch(t.id, patch)}
              onDelete={() => onDelete(t.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoRow({
  todo,
  onToggle,
  onPatch,
  onDelete,
}: {
  todo: PersonalTodo;
  onToggle: () => void;
  onPatch: (patch: Partial<PersonalTodo>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(todo.title);
  const [draftDue, setDraftDue] = useState(todo.due_date ?? "");
  const adminEdited = todo.source_meta?.admin_acted_by;
  const isDone = Boolean(todo.completed_at);
  const [celebrate, setCelebrate] = useState(false);
  function handleToggle() {
    if (!isDone) setCelebrate(true);
    onToggle();
  }

  return (
    <li className="relative px-5 py-2 flex items-start gap-3 hover:bg-canvas/20 transition-colors">
      <TodoCelebration play={celebrate} onDone={() => setCelebrate(false)} />
      <DoneCheckbox done={isDone} onToggle={handleToggle} />
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="space-y-1.5">
            <input
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
            />
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={draftDue}
                onChange={(e) => setDraftDue(e.target.value)}
                className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
              />
              <button
                type="button"
                onClick={() => {
                  const patch: Partial<PersonalTodo> = {};
                  if (draftTitle.trim() && draftTitle.trim() !== todo.title) {
                    patch.title = draftTitle.trim();
                  }
                  const nextDue = draftDue || null;
                  if (nextDue !== todo.due_date) {
                    patch.due_date = nextDue;
                  }
                  if (Object.keys(patch).length > 0) onPatch(patch);
                  setEditing(false);
                }}
                className="px-2 py-0.5 text-xs bg-accent text-accent-fg rounded hover:bg-accent-hover"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftTitle(todo.title);
                  setDraftDue(todo.due_date ?? "");
                  setEditing(false);
                }}
                className="px-2 py-0.5 text-xs border border-border-strong rounded hover:bg-canvas"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p
              className={`text-sm break-words whitespace-pre-wrap ${
                todo.completed_at
                  ? "line-through text-muted"
                  : "text-fg"
              }`}
            >
              {todo.title}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              {todo.due_date ? <span>Due {todo.due_date}</span> : null}
              {todo.priority ? (
                <span className="px-1.5 py-0.5 rounded bg-canvas border border-border">
                  {todo.priority}
                </span>
              ) : null}
              {adminEdited ? (
                <span
                  className="text-[10px] text-amber-700 dark:text-amber-300"
                  title={`Last admin edit: ${adminEdited}${
                    todo.source_meta?.admin_acted_at
                      ? ` at ${todo.source_meta.admin_acted_at}`
                      : ""
                  }`}
                >
                  ✎ admin: {adminEdited}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-accent hover:underline"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="text-red-600 dark:text-red-300 hover:underline"
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
