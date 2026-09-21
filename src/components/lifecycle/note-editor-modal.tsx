"use client";

import { useState } from "react";

interface Props {
  stepTitle: string;
  initialValue: string;
  onSave: (details: string | null) => void;
  onClose: () => void;
  /** When provided, the header becomes an editable text input instead
   *  of a static heading, and Save also commits a changed title
   *  through this callback (skipped if the title wasn't actually
   *  changed, or was cleared to blank). Only wired up from the
   *  Lifecycle board's checklist (stage-todo-list.tsx) — the main
   *  "Your to-dos" panel already edits title inline in its own row,
   *  so it leaves this unset and keeps the modal's header read-only
   *  rather than offering a second, redundant way to rename a row. */
  onSaveTitle?: (title: string) => void;
}

/**
 * Full-size editor for a checklist step's notes (PersonalTodo.details)
 * — the on-card textarea (stage-todo-list.tsx) was too cramped inside
 * a 256px-wide card for anything beyond a one-liner. Modal shell
 * mirrors LifecycleCardModal's (backdrop + centered panel), same
 * visual language as the rest of the Lifecycle board.
 *
 * Explicit Save/Cancel rather than save-on-blur (the inline version's
 * behavior) — a modal invites longer text, so an accidental click
 * outside shouldn't silently commit or discard it without the person
 * noticing either way.
 */
export function NoteEditorModal({
  stepTitle,
  initialValue,
  onSave,
  onClose,
  onSaveTitle,
}: Props) {
  const [draft, setDraft] = useState(initialValue);
  const [titleDraft, setTitleDraft] = useState(stepTitle);

  function handleSave() {
    const next = draft.trim();
    onSave(next || null);
    if (onSaveTitle) {
      const trimmedTitle = titleDraft.trim();
      if (trimmedTitle && trimmedTitle !== stepTitle) onSaveTitle(trimmedTitle);
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border">
          {onSaveTitle ? (
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
              }}
              className="font-semibold text-fg text-sm min-w-0 flex-1 bg-transparent outline-none focus:ring-2 focus:ring-accent rounded px-1 -mx-1 mr-2"
            />
          ) : (
            <h3 className="font-semibold text-fg text-sm min-w-0 break-words pr-2">
              {stepTitle}
            </h3>
          )}
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none flex-shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-3">
          <textarea
            autoFocus
            rows={8}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Add a note — blockers, context, links…"
            className="w-full text-sm px-3 py-2 border border-border rounded-md resize-y bg-canvas text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          />
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
              onClick={handleSave}
              className="px-3 py-1.5 text-sm bg-accent text-accent-fg rounded-md hover:bg-accent-hover"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
