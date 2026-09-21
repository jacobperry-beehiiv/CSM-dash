"use client";

import { useState } from "react";
import type { TodoPriority } from "@/lib/personal-todos/types";
import { CHECKLIST_GROUP_OPTIONS } from "@/lib/lifecycle/checklist-groups";

export interface AddTodoFields {
  title: string;
  due_date: string | null;
  surface_at: string | null;
  priority: TodoPriority | null;
  checklist_group: string;
}

interface Props {
  companyName: string;
  /** Which stage group's "+" was clicked — preselects the checklist
   *  group picker, but stays editable in case the CSM meant a
   *  different group. Company itself is NOT a picker here (unlike the
   *  "Your to-dos" panel's composer) — this modal only ever opens from
   *  a specific customer's card, so there's nothing to choose. */
  initialGroup: string;
  onAdd: (fields: AddTodoFields) => void;
  onClose: () => void;
}

/**
 * On-card "+" companion to the "Your to-dos" panel's composer — same
 * fields, same checklist-group picker (see CHECKLIST_GROUP_OPTIONS),
 * just scoped to the customer/group the CSM already clicked from
 * instead of picking a company out of a dropdown. The caller (the
 * board component) builds the actual PersonalTodo — this modal only
 * collects the form fields, mirroring how NoteEditorModal only
 * collects text and leaves persistence to its caller.
 */
export function AddTodoModal({ companyName, initialGroup, onAdd, onClose }: Props) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [surfaceAt, setSurfaceAt] = useState("");
  const [priority, setPriority] = useState<TodoPriority | "">("");
  const [group, setGroup] = useState(initialGroup);

  function handleAdd() {
    const trimmed = title.trim();
    if (!trimmed) return;
    onAdd({
      title: trimmed,
      due_date: dueDate || null,
      surface_at: surfaceAt || null,
      priority: priority || null,
      checklist_group: group,
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border">
          <h3 className="font-semibold text-fg text-sm min-w-0 break-words pr-2">
            New to-do for {companyName}
          </h3>
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none flex-shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-3">
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            placeholder="What needs doing?"
            className="w-full text-sm px-3 py-2 border border-border rounded-md bg-canvas text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-muted flex items-center gap-1">
              Due
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
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
                value={surfaceAt}
                onChange={(e) => setSurfaceAt(e.target.value)}
                className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-muted flex items-center gap-1">
              Priority
              <select
                value={priority}
                onChange={(e) => setPriority((e.target.value as TodoPriority) || "")}
                className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
              >
                <option value="">No priority</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="text-xs text-muted flex items-center gap-1">
              Checklist group
              <select
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
              >
                <optgroup label="Onboarding">
                  {CHECKLIST_GROUP_OPTIONS.filter((g) => g.section === "Onboarding").map(
                    (g) => (
                      <option key={g.value} value={g.value}>
                        {g.value}
                      </option>
                    )
                  )}
                </optgroup>
                <optgroup label="Live">
                  {CHECKLIST_GROUP_OPTIONS.filter((g) => g.section === "Live").map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.value}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm border border-border-strong rounded-md hover:bg-canvas"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!title.trim()}
              className="px-3 py-1.5 text-sm bg-accent text-accent-fg rounded-md hover:bg-accent-hover disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
