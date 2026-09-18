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
