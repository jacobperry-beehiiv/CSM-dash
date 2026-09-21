import type { PersonalTodo } from "@/lib/personal-todos/types";

/**
 * Shared write path for the on-card checklist (Onboarding + Live
 * boards) — the exact same call personal-todos-panel.tsx's sendOps
 * makes, so ticking a step here and ticking it there are the same
 * state, not two states kept in sync.
 */
export async function toggleLifecycleStep(stepId: string): Promise<void> {
  const r = await fetch("/api/personal-todos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops: [{ type: "toggle_complete", todoId: stepId }] }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${r.status}`);
  }
}

/** Same write path, generic `patch` op instead of `toggle_complete` —
 *  the route already merges any Partial<PersonalTodo> onto the todo,
 *  so a due-date-only edit needs nothing new server-side. Only ever
 *  called for "playbook"-kind steps (real PersonalTodos); the
 *  Renewal-stage checklist has no independent due date to edit. */
export async function patchLifecycleStepDueDate(
  stepId: string,
  dueDate: string | null
): Promise<void> {
  const r = await fetch("/api/personal-todos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ops: [{ type: "patch", todoId: stepId, patch: { due_date: dueDate } }],
    }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${r.status}`);
  }
}

/** Same shape again, patching `details` — the free-text notes field.
 *  Only ever called for "playbook"-kind steps, same reasoning as
 *  patchLifecycleStepDueDate above. */
export async function patchLifecycleStepDetails(
  stepId: string,
  details: string | null
): Promise<void> {
  const r = await fetch("/api/personal-todos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ops: [{ type: "patch", todoId: stepId, patch: { details } }],
    }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${r.status}`);
  }
}

/** Same shape again, patching `title` — wired up only from the
 *  Lifecycle board's own NoteEditorModal instance (via
 *  stage-todo-list.tsx's onEditTitle), since that's the only place a
 *  checklist step has no other way to rename itself; the main
 *  "Your to-dos" panel edits title inline in its row instead. Only
 *  ever called for "playbook"-kind steps, same reasoning as
 *  patchLifecycleStepDueDate above. */
export async function patchLifecycleStepTitle(
  stepId: string,
  title: string
): Promise<void> {
  const r = await fetch("/api/personal-todos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ops: [{ type: "patch", todoId: stepId, patch: { title } }],
    }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${r.status}`);
  }
}

/** Adds a brand-new step via the on-card "+" (add-todo-modal.tsx) —
 *  the same `add` op personal-todos-panel.tsx's composer already
 *  sends, so a todo created from either place is the exact same
 *  PersonalTodo shape. The caller builds the full object (id,
 *  source_meta.checklist_group, etc.) since this module doesn't know
 *  which customer/group it belongs to. */
export async function addLifecycleStep(todo: PersonalTodo): Promise<void> {
  const r = await fetch("/api/personal-todos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops: [{ type: "add", todo }] }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${r.status}`);
  }
}
