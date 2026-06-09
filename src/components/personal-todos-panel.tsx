"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  newTodoId,
  todayYmdUtc,
  type PersonalTodo,
  type PersonalTodoOp,
  type TodoPriority,
  type TodoSource,
} from "@/lib/personal-todos/types";
import { normalizeSlackText } from "@/lib/personal-todos/normalize-text";

/**
 * Personal to-do list — rendered on the home page directly beneath
 * the shared team-tasks panel. Same overall mechanics as TeamTasksPanel:
 *
 *   - Fetches /api/personal-todos on mount and polls every 20s.
 *   - Optimistic local updates with an 800ms debounce on text patches;
 *     atomic ops (add / delete / toggle_complete) ship immediately.
 *   - Per-user — the API derives the user from the NextAuth session.
 *
 * Three "zones" of rows:
 *   1. Active — surface_at null/past, not completed. Shown in main list.
 *   2. Scheduled (surface_at > today) — collapsed under "Scheduled (N)"
 *      so future-dated todos don't crowd today's view.
 *   3. Completed — hidden behind a "Show completed (N)" toggle.
 *
 * Source badge per row tells the CSM how it arrived: manually,
 * scheduled-then-activated, or one of three Slack input vectors.
 */

const PRIORITY_OPTIONS: { value: TodoPriority; label: string; bg: string }[] = [
  {
    value: "high",
    label: "High",
    bg: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
  },
  {
    value: "medium",
    label: "Medium",
    bg: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
  },
  {
    value: "low",
    label: "Low",
    bg: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
  },
];

function priorityStyle(p: TodoPriority | null): string {
  return PRIORITY_OPTIONS.find((o) => o.value === p)?.bg ?? "";
}

const SOURCE_LABEL: Record<TodoSource, { icon: string; label: string }> = {
  manual: { icon: "📝", label: "Manual" },
  scheduled: { icon: "⏰", label: "Scheduled" },
  slack_slash: { icon: "⚡", label: "Slack: /todo" },
  slack_dm: { icon: "💬", label: "Slack DM" },
  slack_reaction: { icon: "👍", label: "Slack reaction" },
};

/** Replace bare URLs with anchors so links pasted into details are
 *  clickable. Mirrors the renderDetails helper in TeamTasksPanel. */
function renderDetails(value: string | null): React.ReactNode {
  if (!value) return null;
  const parts = value.split(/(https?:\/\/\S+)/g);
  return parts.map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline break-all"
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function PersonalTodosPanel() {
  const [todos, setTodos] = useState<PersonalTodo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);

  // Composer state
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDueDate, setDraftDueDate] = useState("");
  const [draftSurfaceAt, setDraftSurfaceAt] = useState("");
  const [draftPriority, setDraftPriority] = useState<TodoPriority | "">("");

  // Pending text patches (same coalescer as team-tasks)
  const pendingPatchesRef = useRef<Map<string, Partial<PersonalTodo>>>(
    new Map()
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load — include scheduled so we can render the dormant
  // section. The endpoint hides them by default.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/personal-todos?include=scheduled")
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as { todos: PersonalTodo[] };
      })
      .then((data) => {
        if (cancelled) return;
        setTodos(data.todos);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Background poll (20s). Skipped while user is editing or saving.
  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (pendingPatchesRef.current.size > 0) return;
      void fetch("/api/personal-todos?include=scheduled")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data) return;
          if (pendingPatchesRef.current.size > 0) return;
          setTodos((data as { todos: PersonalTodo[] }).todos);
        })
        .catch(() => {});
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const sendOps = useCallback(
    async (ops: PersonalTodoOp[]) => {
      if (ops.length === 0) return;
      setSaving(true);
      try {
        const r = await fetch("/api/personal-todos", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ops }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        await r.json().catch(() => ({}));
        setSavedAt(new Date().toISOString());
        setLoadError(null);
      } catch (e) {
        setLoadError(
          `Save failed: ${e instanceof Error ? e.message : "unknown"}`
        );
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const flushPending = useCallback(() => {
    const pending = pendingPatchesRef.current;
    if (pending.size === 0) return;
    const ops: PersonalTodoOp[] = Array.from(pending.entries()).map(
      ([todoId, patch]) => ({ type: "patch", todoId, patch })
    );
    pending.clear();
    void sendOps(ops);
  }, [sendOps]);

  // Flush on unmount with keepalive so a mid-keystroke navigation
  // doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const pending = pendingPatchesRef.current;
      if (pending.size === 0) return;
      const ops: PersonalTodoOp[] = Array.from(pending.entries()).map(
        ([todoId, patch]) => ({ type: "patch", todoId, patch })
      );
      pending.clear();
      void fetch("/api/personal-todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
        keepalive: true,
      });
    };
  }, []);

  function patchTodo(todoId: string, patch: Partial<PersonalTodo>) {
    if (!todos) return;
    setTodos(
      todos.map((t) =>
        t.id === todoId
          ? { ...t, ...patch, updated_at: new Date().toISOString() }
          : t
      )
    );
    const existing = pendingPatchesRef.current.get(todoId) ?? {};
    pendingPatchesRef.current.set(todoId, { ...existing, ...patch });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushPending, 800);
  }

  function toggleComplete(todoId: string) {
    if (!todos) return;
    const now = new Date().toISOString();
    setTodos(
      todos.map((t) =>
        t.id !== todoId
          ? t
          : { ...t, completed_at: t.completed_at ? null : now, updated_at: now }
      )
    );
    void sendOps([{ type: "toggle_complete", todoId }]);
  }

  function deleteTodo(todoId: string) {
    if (!todos) return;
    setTodos(todos.filter((t) => t.id !== todoId));
    void sendOps([{ type: "delete", todoId }]);
  }

  function addFromComposer() {
    // Normalize Slack-pasted text on submit so a copy/pasted message
    // body lands as readable plain text. "<@U123> ping <https://x|here>"
    // becomes "ping here (https://x)" without the user having to
    // hand-edit the line first.
    const title = normalizeSlackText(draftTitle).trim();
    if (!title) return;
    const now = new Date().toISOString();
    const todo: PersonalTodo = {
      id: newTodoId(),
      title,
      details: null,
      due_date: draftDueDate || null,
      surface_at: draftSurfaceAt || null,
      priority: draftPriority || null,
      source: draftSurfaceAt ? "scheduled" : "manual",
      source_meta: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    setTodos((prev) => (prev ? [...prev, todo] : [todo]));
    void sendOps([{ type: "add", todo }]);
    // Reset composer
    setDraftTitle("");
    setDraftDueDate("");
    setDraftSurfaceAt("");
    setDraftPriority("");
  }

  const today = todayYmdUtc();

  // Partition todos into the three zones.
  const { activeTodos, scheduledTodos, completedTodos } = useMemo(() => {
    if (!todos) return { activeTodos: [], scheduledTodos: [], completedTodos: [] };
    const active: PersonalTodo[] = [];
    const scheduled: PersonalTodo[] = [];
    const completed: PersonalTodo[] = [];
    for (const t of todos) {
      if (t.completed_at) {
        completed.push(t);
      } else if (t.surface_at && t.surface_at > today) {
        scheduled.push(t);
      } else {
        active.push(t);
      }
    }
    // Sort active + scheduled by (due_date asc, surface_at asc,
    // created_at asc). Completed by completed_at desc (most recent first).
    const dateSort = (a: PersonalTodo, b: PersonalTodo) => {
      const aDate = a.due_date ?? a.surface_at ?? "";
      const bDate = b.due_date ?? b.surface_at ?? "";
      if (aDate && bDate) {
        const cmp = aDate.localeCompare(bDate);
        if (cmp !== 0) return cmp;
      } else if (aDate) {
        return -1;
      } else if (bDate) {
        return 1;
      }
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    };
    active.sort(dateSort);
    scheduled.sort((a, b) =>
      (a.surface_at ?? "").localeCompare(b.surface_at ?? "")
    );
    completed.sort((a, b) =>
      (b.completed_at ?? "").localeCompare(a.completed_at ?? "")
    );
    return { activeTodos: active, scheduledTodos: scheduled, completedTodos: completed };
  }, [todos, today]);

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card overflow-hidden mt-6">
      <header className="px-5 py-4 border-b border-border flex flex-wrap items-center gap-4">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold text-fg tracking-tight">
            Your to-dos
          </h2>
          <p className="text-[13px] text-muted mt-0.5">
            Personal list — manual, scheduled, or via Slack (`/todo`, DM the bot,
            or react to a message with the trigger emoji).
          </p>
        </div>
        <div className="ml-auto text-[12px] text-muted flex items-center gap-3">
          {saving ? <span>Saving…</span> : null}
          {!saving && savedAt ? (
            <span>Saved {new Date(savedAt).toLocaleTimeString()}</span>
          ) : null}
          {loadError ? (
            <span className="text-red-600 dark:text-red-300">{loadError}</span>
          ) : null}
        </div>
      </header>

      {/* Composer */}
      <div className="px-5 py-3 bg-canvas/30 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addFromComposer();
              }
            }}
            placeholder="What needs doing?"
            className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-border-strong rounded-md bg-surface text-fg"
          />
          <label className="text-xs text-muted flex items-center gap-1">
            Due
            <input
              type="date"
              value={draftDueDate}
              onChange={(e) => setDraftDueDate(e.target.value)}
              className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
            />
          </label>
          <label
            className="text-xs text-muted flex items-center gap-1"
            title="Hide this until the chosen date — useful for follow-ups you don't want crowding today's list."
          >
            Surface on
            <input
              type="date"
              value={draftSurfaceAt}
              onChange={(e) => setDraftSurfaceAt(e.target.value)}
              className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
            />
          </label>
          <select
            value={draftPriority}
            onChange={(e) =>
              setDraftPriority((e.target.value as TodoPriority) || "")
            }
            className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
          >
            <option value="">No priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <button
            type="button"
            onClick={addFromComposer}
            disabled={!draftTitle.trim()}
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      {/* Active list */}
      <div className="divide-y divide-border">
        {todos === null ? (
          <div className="px-5 py-6 text-sm text-muted">Loading…</div>
        ) : activeTodos.length === 0 ? (
          <div className="px-5 py-6 text-sm text-muted">
            Nothing on your list. Add one above, or message the bot in Slack.
          </div>
        ) : (
          activeTodos.map((t) => (
            <TodoRow
              key={t.id}
              todo={t}
              onToggle={() => toggleComplete(t.id)}
              onPatch={(patch) => patchTodo(t.id, patch)}
              onDelete={() => deleteTodo(t.id)}
            />
          ))
        )}
      </div>

      {/* Scheduled (collapsed) */}
      {scheduledTodos.length > 0 ? (
        <div className="border-t border-border bg-canvas/20">
          <button
            type="button"
            onClick={() => setShowScheduled((v) => !v)}
            className="w-full px-5 py-2 text-xs text-muted hover:text-fg text-left"
          >
            {showScheduled ? "▾" : "▸"} Scheduled ({scheduledTodos.length}) —
            hidden until their date
          </button>
          {showScheduled
            ? scheduledTodos.map((t) => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  onToggle={() => toggleComplete(t.id)}
                  onPatch={(patch) => patchTodo(t.id, patch)}
                  onDelete={() => deleteTodo(t.id)}
                  dim
                />
              ))
            : null}
        </div>
      ) : null}

      {/* Completed (hidden by default) */}
      {completedTodos.length > 0 ? (
        <div className="border-t border-border bg-canvas/20">
          <button
            type="button"
            onClick={() => setShowCompleted((v) => !v)}
            className="w-full px-5 py-2 text-xs text-muted hover:text-fg text-left"
          >
            {showCompleted ? "▾" : "▸"} Show completed ({completedTodos.length})
          </button>
          {showCompleted
            ? completedTodos.map((t) => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  onToggle={() => toggleComplete(t.id)}
                  onPatch={(patch) => patchTodo(t.id, patch)}
                  onDelete={() => deleteTodo(t.id)}
                  dim
                />
              ))
            : null}
        </div>
      ) : null}
    </section>
  );
}

interface RowProps {
  todo: PersonalTodo;
  onToggle: () => void;
  onPatch: (patch: Partial<PersonalTodo>) => void;
  onDelete: () => void;
  /** Visually dim — used for scheduled (future) + completed rows so
   *  they don't compete with the active list. */
  dim?: boolean;
}

function TodoRow({ todo, onToggle, onPatch, onDelete, dim }: RowProps) {
  const sourceInfo = SOURCE_LABEL[todo.source] ?? SOURCE_LABEL.manual;
  const isDone = Boolean(todo.completed_at);
  return (
    <div
      className={`px-5 py-3 flex flex-wrap items-start gap-3 ${
        dim ? "opacity-60" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={isDone}
        onChange={onToggle}
        className="mt-1"
        aria-label="Mark complete"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={todo.title}
            onChange={(e) => onPatch({ title: e.target.value })}
            className={`flex-1 min-w-[160px] bg-transparent text-sm text-fg outline-none ${
              isDone ? "line-through text-muted" : ""
            }`}
          />
          {todo.priority ? (
            <span
              className={`text-[11px] px-1.5 py-0.5 rounded ${priorityStyle(
                todo.priority
              )}`}
            >
              {todo.priority[0].toUpperCase() + todo.priority.slice(1)}
            </span>
          ) : null}
          <span
            className="text-[11px] px-1.5 py-0.5 rounded bg-canvas border border-border text-muted"
            title={`Source: ${sourceInfo.label}`}
          >
            {sourceInfo.icon} {sourceInfo.label}
          </span>
          {todo.source_meta?.slack_permalink ? (
            <a
              href={todo.source_meta.slack_permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              ↗ View in Slack
            </a>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-muted">
          <label className="flex items-center gap-1">
            Due
            <input
              type="date"
              value={todo.due_date ?? ""}
              onChange={(e) => onPatch({ due_date: e.target.value || null })}
              className="bg-transparent text-fg"
            />
          </label>
          <label className="flex items-center gap-1">
            Surface on
            <input
              type="date"
              value={todo.surface_at ?? ""}
              onChange={(e) => onPatch({ surface_at: e.target.value || null })}
              className="bg-transparent text-fg"
            />
          </label>
          <select
            value={todo.priority ?? ""}
            onChange={(e) =>
              onPatch({ priority: (e.target.value as TodoPriority) || null })
            }
            className="bg-transparent text-fg"
          >
            <option value="">No priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <label
            className="flex items-center gap-1"
            title="When off, the daily Slack reminder ladder (3d/1d/0d/3d-overdue) skips this row. The activation DM for scheduled todos still fires either way."
          >
            <input
              type="checkbox"
              checked={todo.remind_via_slack !== false}
              onChange={(e) =>
                onPatch({ remind_via_slack: e.target.checked })
              }
            />
            <span>Slack reminders</span>
          </label>
        </div>
        {todo.details ? (
          <div className="mt-1 text-xs text-muted">{renderDetails(todo.details)}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="text-xs text-muted hover:text-red-600 dark:hover:text-red-300 px-2 py-1"
        title="Delete"
      >
        ✕
      </button>
    </div>
  );
}
