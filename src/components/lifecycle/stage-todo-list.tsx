"use client";

import { useState } from "react";
import type { LifecycleStep } from "@/lib/lifecycle/card";
import { CollapsibleSection } from "../collapsible-section";
import { DoneCheckbox } from "../done-checkbox";
import { fmtDate } from "../format";

interface Props {
  steps: LifecycleStep[];
  /** The board's configured column order (without "Unsorted") — used
   *  only to render groups in board order, not to-do-array order. */
  stageOrder: string[];
  /** The card's current effective column (persisted or suggested).
   *  Its group renders expanded; every other stage that has any
   *  to-dos — earlier OR later — renders too, just collapsed, so a
   *  CSM can check off something ahead of schedule without first
   *  dragging the card forward. */
  currentStage: string | null;
  editable: boolean;
  onToggle: (stepId: string) => void;
  /** Present only for "playbook"-kind checklists (Onboarding, Live's
   *  Q1/Q2/Q3) — renders the due date as an editable date input
   *  instead of plain text. Omitted for the Renewal-stage checklist,
   *  whose items have no independent due date at all. */
  onEditDueDate?: (stepId: string, dueDate: string | null) => void;
  /** Present only for "playbook"-kind checklists — same scope as
   *  onEditDueDate. Clicking a step's title opens an inline textarea
   *  for free-text notes (PersonalTodo.details); a small icon marks
   *  a step that already has one. Omitted for the Renewal-stage
   *  checklist, whose items have no independent notes field. */
  onEditDetails?: (stepId: string, details: string | null) => void;
  /** Title for the single flat group when steps carry no per-step
   *  `stage` label (e.g. "Renewal stage" vs the generic "To-dos"
   *  fallback). Ignored when steps do carry stage labels — those
   *  always use the stage name itself as each group's title. */
  flatGroupTitle?: string;
}

/**
 * Card-level checklist, grouped by stage. When steps carry a `stage`
 * label (Onboarding board today), every stage that has any matched
 * to-dos gets its own group, in board order — current stage expanded,
 * every other one collapsed but present and fully interactive. When
 * steps don't carry a stage label (a board with no per-step stage
 * concept yet), everything renders as one flat, expanded group — same
 * information, just not sub-divided.
 *
 * Lives on the card face itself, not hidden behind the modal — stop
 * propagation on the wrapper (and block native drag from starting
 * inside it) so interacting with a checkbox or a group header never
 * triggers the card's click-to-open-modal or its drag handle.
 */
export function StageTodoList({
  steps,
  stageOrder,
  currentStage,
  editable,
  onToggle,
  onEditDueDate,
  onEditDetails,
  flatGroupTitle,
}: Props) {
  const [editingDetailsId, setEditingDetailsId] = useState<string | null>(
    null
  );

  if (steps.length === 0) return null;

  const byStage = new Map<string, LifecycleStep[]>();
  const seenOrder: string[] = [];
  for (const s of steps) {
    const key = s.stage ?? "";
    if (!byStage.has(key)) {
      byStage.set(key, []);
      seenOrder.push(key);
    }
    byStage.get(key)!.push(s);
  }

  const hasStageLabels = seenOrder.some((k) => k !== "");

  // Every stage with at least one matched to-do, in board order —
  // not just current-and-earlier. Falls back to array order for any
  // stage label that isn't in the board's configured list for some
  // reason (shouldn't normally happen).
  const groupKeys = !hasStageLabels
    ? [""]
    : [
        ...stageOrder.filter((k) => byStage.has(k)),
        ...seenOrder.filter((k) => !stageOrder.includes(k)),
      ];

  return (
    <div
      className="mt-2 space-y-1.5"
      onClick={(e) => e.stopPropagation()}
      // The native drag gesture is detected from mousedown, not click —
      // stopping only onClick (below) doesn't stop the card's own
      // draggable div from picking up a mousedown+move that starts on a
      // plain, non-interactive element in here (e.g. the "due" label
      // next to the date input). A <button> like DoneCheckbox is
      // exempt from this natively; a <span> or <input> isn't.
      onMouseDown={(e) => e.stopPropagation()}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
    >
      {groupKeys.map((key) => {
        const groupSteps = byStage.get(key) ?? [];
        if (groupSteps.length === 0) return null;
        const isCurrent = !hasStageLabels || key === currentStage;
        const doneCount = groupSteps.filter((s) => s.completed).length;
        return (
          <CollapsibleSection
            key={`${key}::${currentStage}`}
            title={key || flatGroupTitle || "To-dos"}
            trailing={
              <span className="text-[10px] text-subtle whitespace-nowrap">
                {doneCount}/{groupSteps.length}
              </span>
            }
            defaultOpen={isCurrent}
            bodyClassName="p-2"
          >
            <ul className="space-y-2">
              {groupSteps.map((s) => (
                <li key={s.id} className="flex flex-col gap-0.5">
                  <div className="flex items-start gap-2 min-w-0">
                    <div className="flex-shrink-0 mt-px">
                      <DoneCheckbox
                        done={s.completed}
                        onToggle={() => editable && onToggle(s.id)}
                        size={18}
                        ariaLabel={`Mark "${s.title}" complete`}
                      />
                    </div>
                    {onEditDetails && editable ? (
                      editingDetailsId === s.id ? (
                        <textarea
                          autoFocus
                          rows={2}
                          defaultValue={s.details ?? ""}
                          placeholder="Add a note…"
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.currentTarget.value = s.details ?? "";
                              e.currentTarget.blur();
                            }
                          }}
                          onBlur={(e) => {
                            setEditingDetailsId(null);
                            const next = e.target.value.trim();
                            if (next !== (s.details ?? "").trim()) {
                              onEditDetails(s.id, next || null);
                            }
                          }}
                          className="min-w-0 flex-1 text-xs px-1.5 py-1 border border-accent rounded resize-y bg-surface text-fg focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          title={
                            s.details
                              ? `${s.title}\n\n${s.details}`
                              : `${s.title} — click to add a note`
                          }
                          onClick={() => setEditingDetailsId(s.id)}
                          className={`text-xs min-w-0 break-words text-left hover:underline ${
                            s.completed
                              ? "text-subtle line-through"
                              : "text-fg"
                          }`}
                        >
                          {s.title}
                          {s.details ? (
                            <span className="ml-1" aria-label="Has a note">
                              📝
                            </span>
                          ) : null}
                        </button>
                      )
                    ) : (
                      <span
                        title={s.details ? `${s.title}\n\n${s.details}` : s.title}
                        className={`text-xs min-w-0 break-words ${
                          s.completed ? "text-subtle line-through" : "text-fg"
                        }`}
                      >
                        {s.title}
                        {onEditDetails && s.details ? (
                          <span className="ml-1" aria-label="Has a note">
                            📝
                          </span>
                        ) : null}
                      </span>
                    )}
                  </div>
                  {onEditDueDate ? (
                    <div className="pl-[26px] flex items-center gap-1">
                      <span className="text-[10px] text-subtle">due</span>
                      <input
                        type="date"
                        value={s.due_date ?? ""}
                        onChange={(e) =>
                          editable &&
                          onEditDueDate(s.id, e.target.value || null)
                        }
                        disabled={!editable}
                        draggable={false}
                        className="text-[10px] text-subtle bg-transparent border-none p-0 leading-none disabled:opacity-60"
                      />
                    </div>
                  ) : s.due_date ? (
                    <span className="text-[10px] text-subtle pl-[26px]">
                      due {fmtDate(s.due_date)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        );
      })}
    </div>
  );
}
