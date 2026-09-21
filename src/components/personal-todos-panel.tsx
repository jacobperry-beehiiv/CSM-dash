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
import { CHECKLIST_GROUP_OPTIONS } from "@/lib/lifecycle/checklist-groups";
import { stageDisplayLabel } from "@/lib/lifecycle/stage-labels";
import { DoneCheckbox } from "./done-checkbox";
import { SybillSyncControl } from "./sybill-sync-control";
import { TodoCelebration } from "./todo-celebration";
import { TodoActionButton } from "./todo-action-button";
import { NoteEditorModal } from "./lifecycle/note-editor-modal";
import type {
  AutomatedSource,
  TodoSourceConfig,
} from "@/lib/data/todo-source-configs-types";

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
  feature_request: { icon: "💡", label: "Feature request" },
  slack_assign: { icon: "🎯", label: "Assign playbook" },
  sybill_callrecap: { icon: "📞", label: "Sybill" },
  renewal_milestone: { icon: "🔁", label: "Renewal milestone" },
  renewal_confirmed: { icon: "✅", label: "Renewal confirmed" },
  live_quarter_checkin: { icon: "📅", label: "90-day check-in" },
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

/** Props are all optional — the panel is used from the home page
 *  as the CSM's personal list. New feature-flag-gated slots (like
 *  the Sybill sync affordance) are opt-in, computed server-side in
 *  page.tsx and passed down as booleans. */
/** One entry per customer in the viewer's book that has a HubSpot
 *  company id — the join key the Lifecycle board's checklist matching
 *  requires (matchPlaybookTodos), so anything without one couldn't
 *  ever show up there and isn't worth offering in the picker. */
export interface PlaybookCompanyOption {
  workspace_id: string;
  hubspot_company_id: string;
  name: string;
}

interface PersonalTodosPanelProps {
  /** True when the viewer has the `sybill-ingest` feature flag on —
   *  renders the SybillSyncControl inline above the composer so
   *  syncing recap action items lives with the todos it creates,
   *  not in a separate settings page. */
  sybillIngestEnabled?: boolean;
  /** Feeds the composer's "Company" + "Playbook step" pickers — see
   *  addFromComposer for what selecting both actually does. Computed
   *  server-side in page.tsx from the viewer's own book, same as
   *  sybillIngestEnabled. Empty array (not undefined) when the viewer
   *  has no book — the pickers just render with nothing to choose. */
  playbookCompanies?: PlaybookCompanyOption[];
}

export function PersonalTodosPanel({
  sybillIngestEnabled = false,
  playbookCompanies = [],
}: PersonalTodosPanelProps = {}) {
  const [todos, setTodos] = useState<PersonalTodo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  // Which row's note editor is open — a single modal at the panel
  // level (not one per row), same shell as the Lifecycle board's
  // NoteEditorModal, so notes work identically in both places. Stores
  // just the id, not the todo itself, so the modal always shows the
  // latest local state even if a background poll refreshes `todos`
  // while it's open.
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  // Automated-todo action registry — loaded once on mount. Sparse map
  // (only sources with a customized entry appear); TodoActionButton
  // reads out per-todo whether an outreach template is bound.
  const [sourceConfigs, setSourceConfigs] = useState<
    Partial<Record<AutomatedSource, TodoSourceConfig>>
  >({});

  // Composer state
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDetails, setDraftDetails] = useState("");
  const [draftDueDate, setDraftDueDate] = useState("");
  const [draftSurfaceAt, setDraftSurfaceAt] = useState("");
  const [draftPriority, setDraftPriority] = useState<TodoPriority | "">("");
  // Optional — only when BOTH are picked does the new todo get tagged
  // (source: "slack_assign" + source_meta.checklist_group), so it
  // shows up directly under that grouping on the customer's Lifecycle
  // board card. Either alone is silently ignored — a checklist group
  // with no company (or vice versa) has nothing to attach to. See
  // addFromComposer.
  const [draftWorkspaceId, setDraftWorkspaceId] = useState("");
  const [draftChecklistGroup, setDraftChecklistGroup] = useState("");

  // Pending text patches (same coalescer as team-tasks)
  const pendingPatchesRef = useRef<Map<string, Partial<PersonalTodo>>>(
    new Map()
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the automated-todo action registry once on mount so we
  // know which sources have a linked outreach template. Ignore
  // errors — a failed load just means no action buttons render.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/todo-source-configs")
      .then((r) => r.json())
      .then(
        (
          j: {
            bindings?: Record<
              string,
              {
                default_action: TodoSourceConfig["default_action"];
                action_by_variant?: TodoSourceConfig["action_by_variant"];
              }
            >;
          }
        ) => {
          if (cancelled) return;
          const next: Partial<Record<AutomatedSource, TodoSourceConfig>> = {};
          for (const [source, cfg] of Object.entries(j.bindings ?? {})) {
            next[source as AutomatedSource] = {
              phrasing_template: "",
              default_action: cfg.default_action,
              action_by_variant: cfg.action_by_variant,
            };
          }
          setSourceConfigs(next);
        }
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  /** Sent immediately via sendOps rather than the debounced patchTodo
   *  coalescer — the note editor has an explicit Save button (not
   *  save-on-blur), so there's no rapid-keystroke stream to batch. */
  function saveDetails(todoId: string, details: string | null) {
    if (!todos) return;
    setTodos(
      todos.map((t) =>
        t.id === todoId
          ? { ...t, details, updated_at: new Date().toISOString() }
          : t
      )
    );
    void sendOps([{ type: "patch", todoId, patch: { details } }]);
  }

  /** Auto-fills the title with a "{company} — " prefix as soon as a
   *  company is picked, so the CSM just has to fill in what comes
   *  after — but only while the title is still blank, so it never
   *  clobbers something already typed. Doesn't wait on the checklist
   *  group too — unlike a playbook step, a group has no title text of
   *  its own to append. */
  function maybeAutofillTitle(workspaceId: string) {
    if (draftTitle.trim()) return;
    if (!workspaceId) return;
    const company = playbookCompanies.find((c) => c.workspace_id === workspaceId);
    if (company) setDraftTitle(`${company.name} — `);
  }

  function addFromComposer() {
    // Normalize Slack-pasted text on submit so a copy/pasted message
    // body lands as readable plain text. "<@U123> ping <https://x|here>"
    // becomes "ping here (https://x)" without the user having to
    // hand-edit the line first.
    const title = normalizeSlackText(draftTitle).trim();
    if (!title) return;
    const now = new Date().toISOString();

    const selectedCompany = draftWorkspaceId
      ? playbookCompanies.find((c) => c.workspace_id === draftWorkspaceId)
      : undefined;
    // Only tag it when BOTH are picked — a checklist group with no
    // company (or vice versa) has nothing to attach to, so it falls
    // through to today's plain manual/scheduled todo.
    const playbook =
      selectedCompany && draftChecklistGroup
        ? { company: selectedCompany, group: draftChecklistGroup }
        : null;

    const todo: PersonalTodo = {
      id: newTodoId(),
      title,
      // Whatever the CSM typed into the composer's own notes box, if
      // anything — no auto-generated text here, since the title
      // already carries the "{company} — " prefix (see
      // maybeAutofillTitle) and has nothing left for details to
      // restate.
      details: draftDetails.trim() || null,
      due_date: draftDueDate || null,
      surface_at: draftSurfaceAt || null,
      priority: draftPriority || null,
      source: playbook ? "slack_assign" : draftSurfaceAt ? "scheduled" : "manual",
      source_meta: playbook
        ? {
            hubspot_company_id: playbook.company.hubspot_company_id,
            checklist_group: playbook.group,
          }
        : null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    setTodos((prev) => (prev ? [...prev, todo] : [todo]));
    void sendOps([{ type: "add", todo }]);
    // Reset composer
    setDraftTitle("");
    setDraftDetails("");
    setDraftDueDate("");
    setDraftSurfaceAt("");
    setDraftPriority("");
    setDraftWorkspaceId("");
    setDraftChecklistGroup("");
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

      {/* Sybill sync — moved here from /settings/sybill so the
       *  affordance lives with the todos it creates. Behind the same
       *  `sybill-ingest` feature flag; hidden entirely for CSMs who
       *  don't have it. */}
      {sybillIngestEnabled ? (
        <div className="px-5 py-3 bg-canvas/20 border-b border-border">
          <SybillSyncControl />
        </div>
      ) : null}

      {/* Composer */}
      <div className="px-5 py-3 bg-canvas/30 border-b border-border space-y-2">
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
          className="w-full px-3 py-1.5 text-sm border border-border-strong rounded-md bg-surface text-fg"
        />
        <textarea
          rows={2}
          value={draftDetails}
          onChange={(e) => setDraftDetails(e.target.value)}
          placeholder="Add a note — blockers, context, links… (optional)"
          className="w-full text-sm px-3 py-2 border border-border-strong rounded-md resize-y bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <div className="flex flex-wrap items-center gap-2">
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
          {playbookCompanies.length > 0 ? (
            <>
              <select
                value={draftWorkspaceId}
                onChange={(e) => {
                  setDraftWorkspaceId(e.target.value);
                  maybeAutofillTitle(e.target.value);
                }}
                title="Pick a company + checklist group together to attach this to that customer's Lifecycle board card."
                className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg max-w-[160px]"
              >
                <option value="">No company</option>
                {playbookCompanies.map((c) => (
                  <option key={c.workspace_id} value={c.workspace_id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={draftChecklistGroup}
                onChange={(e) => setDraftChecklistGroup(e.target.value)}
                title="Pick a company + checklist group together to attach this to that customer's Lifecycle board card."
                className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg max-w-[160px]"
              >
                <option value="">No checklist group</option>
                <optgroup label="Onboarding">
                  {CHECKLIST_GROUP_OPTIONS.filter((g) => g.section === "Onboarding").map(
                    (g) => (
                      <option key={g.value} value={g.value}>
                        {stageDisplayLabel(g.value)}
                      </option>
                    )
                  )}
                </optgroup>
                <optgroup label="Live">
                  {CHECKLIST_GROUP_OPTIONS.filter((g) => g.section === "Live").map((g) => (
                    <option key={g.value} value={g.value}>
                      {stageDisplayLabel(g.value)}
                    </option>
                  ))}
                </optgroup>
              </select>
            </>
          ) : null}
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
              onOpenNotes={() => setEditingNotesId(t.id)}
              sourceConfigs={sourceConfigs}
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
                  onOpenNotes={() => setEditingNotesId(t.id)}
                  sourceConfigs={sourceConfigs}
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
                  onOpenNotes={() => setEditingNotesId(t.id)}
                  sourceConfigs={sourceConfigs}
                  dim
                />
              ))
            : null}
        </div>
      ) : null}

      {editingNotesId ? (
        (() => {
          const editing = todos?.find((t) => t.id === editingNotesId);
          if (!editing) return null;
          return (
            <NoteEditorModal
              stepTitle={editing.title}
              initialValue={editing.details ?? ""}
              onSave={(details) => saveDetails(editing.id, details)}
              onClose={() => setEditingNotesId(null)}
            />
          );
        })()
      ) : null}
    </section>
  );
}

interface RowProps {
  todo: PersonalTodo;
  onToggle: () => void;
  onPatch: (patch: Partial<PersonalTodo>) => void;
  onDelete: () => void;
  /** Opens the shared NoteEditorModal (rendered once at the panel
   *  level) for this row — same modal + Save/Cancel workflow the
   *  Lifecycle board's checklist items already use, so notes work
   *  identically in both places. */
  onOpenNotes: () => void;
  /** Automated-todo action registry loaded by the parent. Passed to
   *  TodoActionButton to decide whether a "Draft outreach" button
   *  renders for this todo. */
  sourceConfigs: Partial<Record<AutomatedSource, TodoSourceConfig>>;
  /** Visually dim — used for scheduled (future) + completed rows so
   *  they don't compete with the active list. */
  dim?: boolean;
}

function TodoRow({
  todo,
  onToggle,
  onPatch,
  onDelete,
  onOpenNotes,
  sourceConfigs,
  dim,
}: RowProps) {
  const sourceInfo = SOURCE_LABEL[todo.source] ?? SOURCE_LABEL.manual;
  const isDone = Boolean(todo.completed_at);
  // Fires the celebration overlay only on the not-done → done
  // transition. We DEFER the actual onToggle call until the
  // animation finishes — otherwise completing a row would re-sort
  // it into the "Completed" section (collapsed by default),
  // unmounting the row mid-animation and killing the sweep before
  // it played.
  const [celebrate, setCelebrate] = useState(false);
  // Optimistic-done state: while celebrating, the checkbox shows
  // done so the click feels instant even though the actual toggle
  // is deferred until the animation finishes.
  const visualDone = isDone || celebrate;
  function handleToggle() {
    if (isDone) {
      // Un-toggling — fire immediately, no celebration.
      onToggle();
      return;
    }
    // Going to done — start the celebration, defer the toggle.
    setCelebrate(true);
  }
  function finishCelebration() {
    setCelebrate(false);
    // Fire the actual completion now that the animation has
    // played. The parent re-sorts the row into Completed.
    onToggle();
  }
  return (
    <div
      className={`relative px-5 py-3 flex flex-wrap items-start gap-3 ${
        dim ? "opacity-60" : ""
      }`}
    >
      <TodoCelebration play={celebrate} onDone={finishCelebration} />
      <DoneCheckbox done={visualDone} onToggle={handleToggle} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={todo.title}
            onChange={(e) => onPatch({ title: e.target.value })}
            className={`flex-1 min-w-[160px] bg-transparent text-sm text-fg outline-none ${
              visualDone ? "line-through text-muted" : ""
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
          {todo.source_meta?.workspace_id ? (
            // Link to /account/[workspace_id] — the same "Open full
            // account view" destination that lives inside the customer
            // detail panel. One click from a fired todo to the
            // customer's full account page. Absent on slack_assign +
            // manual todos with no workspace metadata.
            <a
              href={`/account/${encodeURIComponent(
                todo.source_meta.workspace_id
              )}`}
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
              title="Open this customer's full account view"
            >
              ↗ Open full account view
            </a>
          ) : null}
          <TodoActionButton todo={todo} sourceConfigs={sourceConfigs} />
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
        <div className="mt-1 flex items-start gap-1.5">
          <button
            type="button"
            onClick={onOpenNotes}
            title={todo.details ? `Note: ${todo.details}` : "Add a note"}
            aria-label={todo.details ? "Edit note" : "Add a note"}
            className={`text-[13px] leading-none flex-shrink-0 ${
              todo.details ? "" : "opacity-30 hover:opacity-70"
            }`}
          >
            📝
          </button>
          {todo.details ? (
            <div className="text-xs text-muted min-w-0">{renderDetails(todo.details)}</div>
          ) : null}
        </div>
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
