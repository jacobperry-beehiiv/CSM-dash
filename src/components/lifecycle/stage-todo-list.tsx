"use client";

import { useState } from "react";
import type { LifecycleStep } from "@/lib/lifecycle/card";
import { CollapsibleSection } from "../collapsible-section";
import { DoneCheckbox } from "../done-checkbox";
import { NoteEditorModal } from "./note-editor-modal";
import { AddTodoModal, type AddTodoFields } from "./add-todo-modal";
import { CHECKLIST_GROUP_OPTIONS } from "@/lib/lifecycle/checklist-groups";
import { isScheduledFor, todayYmdUtc } from "@/lib/personal-todos/types";
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
   *  onEditDueDate. Clicking a step's title opens a full-size modal
   *  editor for free-text notes (PersonalTodo.details) — the on-card
   *  space is too tight for anything past a one-liner. A small icon
   *  marks a step that already has one. Omitted for the Renewal-stage
   *  checklist, whose items have no independent notes field. */
  onEditDetails?: (stepId: string, details: string | null) => void;
  /** Present only for "playbook"-kind checklists — same scope as
   *  onEditDueDate/onEditDetails. Lets NoteEditorModal's header become
   *  an editable rename field instead of a static title — the on-card
   *  checklist has no other way to rename a step. Omitted for the
   *  Renewal-stage checklist, whose step ids are stage labels rather
   *  than real todos. */
  onEditTitle?: (stepId: string, title: string) => void;
  /** Title for the single flat group when steps carry no per-step
   *  `stage` label (e.g. "Renewal stage" vs the generic "To-dos"
   *  fallback). Ignored when steps do carry stage labels — those
   *  always use the stage name itself as each group's title. */
  flatGroupTitle?: string;
  /** Present only for "playbook"-kind checklists — same scope as
   *  onEditDueDate/onEditDetails. Renders a small "+" in each stage
   *  group's header that opens AddTodoModal, pre-selecting that
   *  group. Omitted for the Renewal-stage checklist (no real
   *  checklist_group to attach a new item to) and for a card with no
   *  known HubSpot company id (nothing for a new todo to match on). */
  onAddStep?: (group: string, fields: AddTodoFields) => void;
  /** Customer name shown in AddTodoModal's header ("New to-do for
   *  {companyName}"). Required whenever onAddStep is provided. */
  companyName?: string;
}

/** Above-the-fold cap on completed items per stage group — a
 *  long-lived account's checklist otherwise keeps every completed
 *  item on the card forever, crowding out what's actually open.
 *  Mirrors personal-todos-panel.tsx's "Show completed (N)" pattern,
 *  just applied per stage group instead of once for the whole list. */
const RECENT_COMPLETED_LIMIT = 5;

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
  onEditTitle,
  flatGroupTitle,
  onAddStep,
  companyName,
}: Props) {
  const [editingDetailsId, setEditingDetailsId] = useState<string | null>(
    null
  );
  const [addingToGroup, setAddingToGroup] = useState<string | null>(null);
  // Which stage groups have "Show N more completed" expanded — keyed
  // by stage name (stable across a currentStage change, unlike
  // CollapsibleSection's own remount-on-stage-change key below), so
  // toggling one group open doesn't get silently reset when the card
  // is dragged to a new column.
  const [expandedCompletedGroups, setExpandedCompletedGroups] = useState<
    Set<string>
  >(new Set());
  // Same idea, for "Scheduled (N)" — a pending step whose surface_at
  // is still in the future stays hidden per group until its date
  // arrives or a CSM expands it here, mirroring the main "Your to-dos"
  // panel's dormant-until-surfaced treatment (isScheduledFor).
  const [expandedScheduledGroups, setExpandedScheduledGroups] = useState<
    Set<string>
  >(new Set());

  if (steps.length === 0) return null;

  const today = todayYmdUtc();

  const editingStep = steps.find((s) => s.id === editingDetailsId) ?? null;

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

  function renderStep(s: LifecycleStep) {
    return (
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
            <button
              type="button"
              title={
                s.details
                  ? `${s.title}\n\n${s.details}`
                  : `${s.title} — click to add a note`
              }
              onClick={() => setEditingDetailsId(s.id)}
              className={`text-xs min-w-0 break-words text-left hover:underline ${
                s.completed ? "text-subtle line-through" : "text-fg"
              }`}
            >
              {s.details ? (
                <span className="mr-1" aria-label="Has a note">
                  📝
                </span>
              ) : null}
              {s.title}
            </button>
          ) : (
            <span
              title={s.details ? `${s.title}\n\n${s.details}` : s.title}
              className={`text-xs min-w-0 break-words ${
                s.completed ? "text-subtle line-through" : "text-fg"
              }`}
            >
              {onEditDetails && s.details ? (
                <span className="mr-1" aria-label="Has a note">
                  📝
                </span>
              ) : null}
              {s.title}
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
                editable && onEditDueDate(s.id, e.target.value || null)
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
    );
  }

  function toggleCompletedGroup(key: string) {
    setExpandedCompletedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function toggleScheduledGroup(key: string) {
    setExpandedScheduledGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

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

        const pending = groupSteps.filter((s) => !s.completed);
        const scheduledPending = pending.filter((s) => isScheduledFor(s, today));
        const visiblePending = pending.filter((s) => !isScheduledFor(s, today));
        const completedSorted = groupSteps
          .filter((s) => s.completed)
          .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
        const recentCompleted = completedSorted.slice(0, RECENT_COMPLETED_LIMIT);
        const olderCompleted = completedSorted.slice(RECENT_COMPLETED_LIMIT);
        const groupExpanded = expandedCompletedGroups.has(key);
        const scheduledExpanded = expandedScheduledGroups.has(key);
        // Only the 4 real checklist groups (Pre-kickoff/Post-kickoff/
        // Migration & warm-up/Live) are valid source_meta.checklist_group
        // values — Q1/Q2/Q3 are computed renewal-quarter buckets a real
        // playbook step's due date lands in, not something a one-off
        // manual todo can be tagged with (see live-quarter.ts's own
        // comment on LIVE_ONGOING_GROUP). Showing "+" there would let a
        // CSM "add" a todo to a group AddTodoModal's picker doesn't
        // even offer.
        const isAssignableGroup = CHECKLIST_GROUP_OPTIONS.some((g) => g.value === key);

        return (
          <CollapsibleSection
            key={`${key}::${currentStage}`}
            title={key || flatGroupTitle || "To-dos"}
            trailing={
              <span className="flex items-center gap-1.5">
                {onAddStep && editable && isAssignableGroup ? (
                  <button
                    type="button"
                    onClick={() => setAddingToGroup(key)}
                    title={`Add a to-do to ${key}`}
                    aria-label={`Add a to-do to ${key}`}
                    className="text-subtle hover:text-fg leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-canvas text-sm"
                  >
                    +
                  </button>
                ) : null}
                <span className="text-[10px] text-subtle whitespace-nowrap">
                  {doneCount}/{groupSteps.length}
                </span>
              </span>
            }
            defaultOpen={isCurrent}
            bodyClassName="p-2"
          >
            <ul className="space-y-2">
              {visiblePending.map(renderStep)}
              {recentCompleted.map(renderStep)}
            </ul>
            {scheduledPending.length > 0 ? (
              <button
                type="button"
                onClick={() => toggleScheduledGroup(key)}
                className="mt-1.5 text-[10px] text-subtle hover:text-fg"
              >
                {scheduledExpanded ? "▾" : "▸"} Scheduled ({scheduledPending.length}) —
                hidden until their date
              </button>
            ) : null}
            {scheduledExpanded ? (
              <ul className="space-y-2 mt-2">{scheduledPending.map(renderStep)}</ul>
            ) : null}
            {olderCompleted.length > 0 ? (
              <button
                type="button"
                onClick={() => toggleCompletedGroup(key)}
                className="mt-1.5 text-[10px] text-subtle hover:text-fg"
              >
                {groupExpanded ? "▾" : "▸"} Show {olderCompleted.length} more
                completed
              </button>
            ) : null}
            {groupExpanded ? (
              <ul className="space-y-2 mt-2">{olderCompleted.map(renderStep)}</ul>
            ) : null}
          </CollapsibleSection>
        );
      })}
      {editingStep && onEditDetails ? (
        <NoteEditorModal
          stepTitle={editingStep.title}
          initialValue={editingStep.details ?? ""}
          onSave={(details) => onEditDetails(editingStep.id, details)}
          onClose={() => setEditingDetailsId(null)}
          onSaveTitle={
            onEditTitle ? (title) => onEditTitle(editingStep.id, title) : undefined
          }
        />
      ) : null}
      {addingToGroup && onAddStep ? (
        <AddTodoModal
          companyName={companyName ?? "this customer"}
          initialGroup={addingToGroup}
          onAdd={(fields) => onAddStep(addingToGroup, fields)}
          onClose={() => setAddingToGroup(null)}
        />
      ) : null}
    </div>
  );
}
