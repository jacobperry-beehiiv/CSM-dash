"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isTaskComplete,
  nextAssignmentState,
  type AssignmentState,
  type TaskPriority,
  type TeamMember,
  type TeamTask,
  type TeamTaskList,
} from "@/lib/team-tasks/types";

/**
 * Shared team task list — mirrors the spreadsheet that #csm-dream-team-v2
 * used to track cross-team asks. One row per ask, one column per CSM,
 * tri-state per-cell (☐ → ✓ → N/A → ☐).
 *
 * Autosaves to /api/team-tasks 800ms after the last change. Concurrent
 * edits from different CSMs are last-write-wins on the whole list; the
 * volumes are tiny enough that contention is unlikely.
 *
 * Embedded inline on the mission-control root page rather than in a
 * modal so the team's open asks are visible without an extra click.
 */

const PRIORITY_OPTIONS: { value: TaskPriority; label: string; bg: string }[] = [
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

function priorityStyle(p: TaskPriority | null): string {
  return PRIORITY_OPTIONS.find((o) => o.value === p)?.bg ?? "";
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function emptyTask(): TeamTask {
  const now = new Date().toISOString();
  return {
    id: newId(),
    ask: "",
    due_date: null,
    loe: null,
    priority: null,
    details: null,
    assignments: {},
    created_at: now,
    updated_at: now,
  };
}

/** Replace bare URLs with anchors so links pasted into the Details cell
 *  are clickable. Otherwise the cell renders as plain text. */
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

export function TeamTasksPanel() {
  const [list, setList] = useState<TeamTaskList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hideCompleted, setHideCompleted] = useState(true);
  const [detailsEditingId, setDetailsEditingId] = useState<string | null>(null);

  // Track which row was edited last so the autosave debounce can fire on
  // unmount.
  const dirtyRef = useRef<TeamTaskList | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    fetch("/api/team-tasks")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as TeamTaskList;
      })
      .then((data) => {
        if (cancelled) return;
        setList(data);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: TeamTaskList) => {
    setSaving(true);
    try {
      const r = await fetch("/api/team-tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setLoadError(`Save failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setSaving(false);
    }
  }, []);

  /** Apply an update + schedule autosave. Always pass the full new list. */
  const update = useCallback(
    (next: TeamTaskList) => {
      setList(next);
      dirtyRef.current = next;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (dirtyRef.current) save(dirtyRef.current);
      }, 800);
    },
    [save]
  );

  // Flush pending save on unmount so navigating away mid-keystroke
  // doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (dirtyRef.current) {
        void fetch("/api/team-tasks", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dirtyRef.current),
          keepalive: true,
        });
      }
    };
  }, []);

  function patchTask(taskId: string, patch: Partial<TeamTask>) {
    if (!list) return;
    const next: TeamTaskList = {
      ...list,
      tasks: list.tasks.map((t) =>
        t.id === taskId
          ? { ...t, ...patch, updated_at: new Date().toISOString() }
          : t
      ),
    };
    update(next);
  }

  function cycleAssignment(taskId: string, memberId: string) {
    if (!list) return;
    const task = list.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const current = task.assignments[memberId] ?? "unchecked";
    const nextState = nextAssignmentState(current);
    patchTask(taskId, {
      assignments: { ...task.assignments, [memberId]: nextState },
    });
  }

  function addTask() {
    if (!list) return;
    update({ ...list, tasks: [...list.tasks, emptyTask()] });
  }

  function deleteTask(taskId: string) {
    if (!list) return;
    update({ ...list, tasks: list.tasks.filter((t) => t.id !== taskId) });
  }

  const visibleTasks = useMemo(() => {
    if (!list) return [];
    const filtered = hideCompleted
      ? list.tasks.filter((t) => !isTaskComplete(t, list.members))
      : list.tasks;
    // Earliest due-date first; tasks without a due date sink to the
    // bottom (sorted by created_at among themselves so adding a task
    // doesn't shuffle the existing TBD pile). Stable sort comes for
    // free from Array#sort in modern engines.
    return [...filtered].sort((a, b) => {
      const aHas = Boolean(a.due_date);
      const bHas = Boolean(b.due_date);
      if (aHas && bHas) return a.due_date!.localeCompare(b.due_date!);
      if (aHas) return -1;
      if (bHas) return 1;
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    });
  }, [list, hideCompleted]);

  const hiddenCount = list ? list.tasks.length - visibleTasks.length : 0;

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card overflow-hidden">
      <header className="px-5 py-4 border-b border-border flex flex-wrap items-center gap-4">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold text-fg tracking-tight">
            Team tasks
          </h2>
          <p className="text-[13px] text-muted mt-0.5">
            Shared cross-team ask list. Click any cell to cycle
            ☐ → ✓ → N/A → ☐.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={hideCompleted}
              onChange={(e) => setHideCompleted(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer"
            />
            Hide completed
            {hideCompleted && hiddenCount > 0 ? (
              <span className="text-subtle">({hiddenCount} hidden)</span>
            ) : null}
          </label>
          <span className="text-xs text-muted min-w-[80px] text-right">
            {saving ? (
              <span>Saving…</span>
            ) : loadError ? (
              <span className="text-red-600">{loadError}</span>
            ) : savedAt ? (
              <span className="text-subtle">
                Saved{" "}
                {new Date(savedAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            ) : null}
          </span>
          <button
            onClick={addTask}
            disabled={!list}
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            + Add task
          </button>
        </div>
      </header>

      <div className="overflow-auto">
        {!list && !loadError ? (
          <div className="p-8 text-sm text-muted text-center">Loading…</div>
        ) : null}
        {list ? (
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-accent text-accent-fg">
              <tr>
                <Th className="text-left w-[24%]">Ask</Th>
                <Th className="text-left w-[10%]">Due date</Th>
                <Th className="text-left w-[8%]">LOE</Th>
                <Th className="text-left w-[9%]">Priority</Th>
                <Th className="text-left w-[20%]">Details</Th>
                {list.members.map((m) => (
                  <Th key={m.id} className="text-center w-[3.5%]">
                    {m.label}
                  </Th>
                ))}
                <Th className="w-[3%]" />
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  members={list.members}
                  isDetailsEditing={detailsEditingId === t.id}
                  onStartEditDetails={() => setDetailsEditingId(t.id)}
                  onStopEditDetails={() => setDetailsEditingId(null)}
                  onPatch={(p) => patchTask(t.id, p)}
                  onCycle={(memberId) => cycleAssignment(t.id, memberId)}
                  onDelete={() => deleteTask(t.id)}
                />
              ))}
              {visibleTasks.length === 0 ? (
                <tr>
                  <td
                    colSpan={5 + list.members.length + 1}
                    className="text-center text-muted text-sm py-8"
                  >
                    {hideCompleted && hiddenCount > 0
                      ? `All ${hiddenCount} tasks complete. Uncheck "Hide completed" to review.`
                      : 'No tasks yet — click "Add task" to start.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}

function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-2 py-2 text-xs font-semibold border-b border-border ${className}`}
    >
      {children}
    </th>
  );
}

function TaskRow({
  task,
  members,
  isDetailsEditing,
  onStartEditDetails,
  onStopEditDetails,
  onPatch,
  onCycle,
  onDelete,
}: {
  task: TeamTask;
  members: TeamMember[];
  isDetailsEditing: boolean;
  onStartEditDetails: () => void;
  onStopEditDetails: () => void;
  onPatch: (patch: Partial<TeamTask>) => void;
  onCycle: (memberId: string) => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-b border-border align-top hover:bg-canvas/40">
      <td className="px-2 py-1.5 font-medium text-fg">
        <input
          type="text"
          value={task.ask}
          onChange={(e) => onPatch({ ask: e.target.value })}
          placeholder="Programmatic Ads Beta Outreach…"
          className="w-full px-1.5 py-1 bg-transparent border border-transparent hover:border-border focus:border-accent rounded text-sm focus:outline-none"
        />
      </td>
      <td className="px-2 py-1.5 text-muted">
        <input
          type="date"
          value={task.due_date ?? ""}
          onChange={(e) => onPatch({ due_date: e.target.value || null })}
          className="w-full px-1.5 py-1 bg-transparent border border-transparent hover:border-border focus:border-accent rounded text-sm focus:outline-none"
        />
      </td>
      <td className="px-2 py-1.5 text-muted">
        <input
          type="text"
          value={task.loe ?? ""}
          onChange={(e) => onPatch({ loe: e.target.value || null })}
          placeholder="10 mins"
          className="w-full px-1.5 py-1 bg-transparent border border-transparent hover:border-border focus:border-accent rounded text-sm focus:outline-none"
        />
      </td>
      <td className="px-2 py-1.5">
        <select
          value={task.priority ?? ""}
          onChange={(e) =>
            onPatch({
              priority: (e.target.value || null) as TaskPriority | null,
            })
          }
          className={`w-full px-1.5 py-1 border border-border-strong rounded text-xs font-medium ${priorityStyle(
            task.priority
          )}`}
        >
          <option value="">—</option>
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5 text-muted">
        {isDetailsEditing ? (
          <textarea
            autoFocus
            value={task.details ?? ""}
            onChange={(e) => onPatch({ details: e.target.value || null })}
            onBlur={onStopEditDetails}
            rows={2}
            placeholder="Paste a Slack link, email subject line, or notes…"
            className="w-full px-1.5 py-1 border border-accent rounded text-sm focus:outline-none resize-y"
          />
        ) : (
          <button
            onClick={onStartEditDetails}
            className="w-full text-left px-1.5 py-1 border border-transparent hover:border-border rounded text-xs min-h-[1.75rem]"
            title="Click to edit"
          >
            {task.details ? (
              renderDetails(task.details)
            ) : (
              <span className="text-subtle italic">click to add details…</span>
            )}
          </button>
        )}
      </td>
      {members.map((m) => {
        const state: AssignmentState = task.assignments[m.id] ?? "unchecked";
        return (
          <td key={m.id} className="px-1 py-1.5 text-center">
            <button
              onClick={() => onCycle(m.id)}
              className={`inline-flex items-center justify-center w-7 h-7 rounded text-sm font-semibold border ${
                state === "checked"
                  ? "bg-green-100 dark:bg-green-500/20 border-green-500 text-green-700 dark:text-green-300"
                  : state === "na"
                    ? "bg-surface-2 border-border text-subtle"
                    : "bg-surface border-border-strong text-subtle hover:border-accent"
              }`}
              aria-label={`${m.label}: ${state}`}
              title={`${m.label} · ${
                state === "checked"
                  ? "done"
                  : state === "na"
                    ? "N/A"
                    : "not done"
              } — click to cycle`}
            >
              {state === "checked"
                ? "✓"
                : state === "na"
                  ? "N/A"
                  : " "}
            </button>
          </td>
        );
      })}
      <td className="px-1 py-1.5 text-center">
        <button
          onClick={onDelete}
          className="text-subtle hover:text-red-600 text-xs"
          title="Delete this task"
          aria-label="Delete task"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}
