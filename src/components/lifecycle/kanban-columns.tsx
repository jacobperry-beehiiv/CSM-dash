"use client";

import { useState } from "react";
import type { LifecycleCard } from "@/lib/lifecycle/card";
import { fmtCurrency } from "../format";
import { StatusBadge } from "../status-badge";
import { StageTodoList } from "./stage-todo-list";
import type { AddTodoFields } from "./add-todo-modal";

/** Fixed catch-all column — never part of a board's configurable
 *  column list. Callers decide where it sits in `columns` (leftmost
 *  for Onboarding/Live, trailing for Renewal) — this component just
 *  renders whatever order it's given. */
export const UNSORTED = "Unsorted";

interface Props {
  /** Full column order, "Unsorted" included wherever the caller wants
   *  it positioned. */
  columns: string[];
  cardsByColumn: Map<string, LifecycleCard[]>;
  /** Column order used only for the on-card checklist's stage
   *  grouping (which stages count as "previous" vs "current") — the
   *  board's real stage list, without "Unsorted" mixed in. Omit on
   *  boards with no per-step stage concept (e.g. Renewal, which never
   *  has steps at all). */
  stageOrder?: string[];
  draggable: boolean;
  onDrop?: (workspaceId: string, column: string) => void;
  onCardClick: (workspaceId: string) => void;
  /** Present only on boards whose cards carry a to-do checklist
   *  (Onboarding, Live). Renewal cards never have steps, so this is
   *  never called there. */
  onToggleStep?: (workspaceId: string, stepId: string) => void;
  /** Present only on boards whose checklist steps have a real,
   *  editable due date (playbook-kind — Onboarding, Live's Q1/Q2/Q3).
   *  Never called for a Renewal-stage card — see the per-card gate
   *  in this component's own render. */
  onEditDueDate?: (
    workspaceId: string,
    stepId: string,
    dueDate: string | null
  ) => void;
  /** Present only on boards whose checklist steps carry editable
   *  free-text notes (playbook-kind — same scope as onEditDueDate).
   *  Never called for a Renewal-stage card. */
  onEditDetails?: (
    workspaceId: string,
    stepId: string,
    details: string | null
  ) => void;
  /** Present only on boards whose checklist steps can be renamed from
   *  NoteEditorModal's own editable header — same scope as
   *  onEditDueDate/onEditDetails. Never called for a Renewal-stage
   *  card, whose step ids are stage labels rather than real todos. */
  onEditTitle?: (workspaceId: string, stepId: string, title: string) => void;
  /** Present only on boards whose cards carry a checklist a CSM can
   *  add one-off items to (Onboarding, Live) — same scope as
   *  onEditDueDate/onEditDetails. Never called for a Renewal-stage
   *  card (gated per-card below, alongside those two) or a card with
   *  no known HubSpot company id (nothing for a new todo to match
   *  on). */
  onAddTodo?: (workspaceId: string, group: string, fields: AddTodoFields) => void;
  /** Stage keys that should always render their own checklist group,
   *  even with zero matched steps — see StageTodoList's own doc
   *  comment. Board-wide (like stageOrder), but gated off per-card
   *  for a Renewal-stage card below, same as onAddTodo. Only the Live
   *  board passes this (LIVE_ONGOING_GROUP) — Onboarding's groups
   *  always have real playbook steps already. */
  alwaysShowGroups?: string[];
  /** Replaces the default status-badge row on each card when
   *  provided (e.g. Live board swaps it for the renewal date, since
   *  "Live"/"Onboarding" is redundant with which board you're already
   *  looking at). Falls back to the plain status badge when omitted. */
  renderCardMeta?: (card: LifecycleCard) => React.ReactNode;
  /** Renders in place of the checklist for a card with zero matched
   *  steps (StageTodoList itself renders nothing in that case). Only
   *  the Onboarding board supplies this today — see
   *  backfill-onboarding-button.tsx — since an empty Live-board
   *  checklist doesn't have an equivalent recovery action. Omitted
   *  entirely on boards where an empty checklist is unremarkable. */
  renderEmptyChecklist?: (card: LifecycleCard) => React.ReactNode;
}

/**
 * Presentational Kanban grid shared by all three Lifecycle sub-boards
 * (Onboarding, Live, Renewal). Each board owns its own data-fetching
 * and mutation logic and just hands this component the already-built
 * `cardsByColumn` map — this component only renders it, plus (when
 * `draggable`) native HTML5 drag/drop events, which is the whole
 * interaction: no external drag library, matching this app's
 * existing zero-dependencies-for-DnD baseline.
 *
 * Each card's to-do checklist (StageTodoList) lives on the card face
 * itself, not behind the click-to-open modal, so a CSM can act on it
 * without leaving the board. That checklist stops its own click/drag
 * events from bubbling, so interacting with a checkbox never opens
 * the modal or starts a card drag.
 */
export function KanbanColumns({
  columns,
  cardsByColumn,
  stageOrder,
  draggable,
  onDrop,
  onCardClick,
  onToggleStep,
  onEditDueDate,
  onEditDetails,
  onEditTitle,
  onAddTodo,
  alwaysShowGroups,
  renderCardMeta,
  renderEmptyChecklist,
}: Props) {
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((col) => {
        const colCards = cardsByColumn.get(col) ?? [];
        const arrSum = colCards.reduce((s, c) => s + c.customer.arr, 0);
        const isDragOver = dragOverColumn === col;
        // Renewal-stage cards (Live board's "Renewal" column only —
        // detected by checklist_kind, not the column's literal name,
        // so an admin-renamed Onboarding stage can never accidentally
        // trigger this) split ARR by whether "Renewal Confirmed" is
        // checked, since a confirmed renewal is meaningfully different
        // from one still in flight (which includes "Renewal Lost" —
        // deliberately lumped into "pending" rather than a 3rd bucket,
        // per product decision).
        const isRenewalStageColumn = colCards.some(
          (c) => c.checklist_kind === "renewal_stage"
        );
        const confirmedArr = isRenewalStageColumn
          ? colCards
              .filter((c) => c.steps.find((s) => s.id === "Renewal Confirmed")?.completed)
              .reduce((s, c) => s + c.customer.arr, 0)
          : 0;
        return (
          <div
            key={col}
            onDragOver={
              draggable
                ? (e) => {
                    e.preventDefault();
                    setDragOverColumn(col);
                  }
                : undefined
            }
            onDragLeave={
              draggable
                ? () => setDragOverColumn((cur) => (cur === col ? null : cur))
                : undefined
            }
            onDrop={
              draggable
                ? (e) => {
                    e.preventDefault();
                    setDragOverColumn(null);
                    const workspaceId = e.dataTransfer.getData("text/plain");
                    if (workspaceId) onDrop?.(workspaceId, col);
                  }
                : undefined
            }
            className={`flex-shrink-0 w-64 bg-canvas border rounded-lg transition-colors ${
              isDragOver ? "border-accent" : "border-border"
            } ${col === UNSORTED ? "border-dashed" : ""}`}
          >
            <div className="px-3 py-2 border-b border-border">
              <div className="text-sm font-semibold text-fg">{col}</div>
              <div className="text-xs text-muted mt-0.5">
                {isRenewalStageColumn ? (
                  <>
                    {colCards.length} · {fmtCurrency(arrSum - confirmedArr)}{" "}
                    pending ARR · {fmtCurrency(confirmedArr)} confirmed ARR
                  </>
                ) : (
                  <>
                    {colCards.length} · {fmtCurrency(arrSum)} ARR
                  </>
                )}
              </div>
            </div>
            <div className="p-2 space-y-2 min-h-[80px]">
              {colCards.length === 0 ? (
                <div className="text-xs text-subtle px-1 py-2">
                  {draggable
                    ? col === UNSORTED
                      ? "Nothing unsorted"
                      : "Drop a card here"
                    : "No accounts"}
                </div>
              ) : (
                colCards.map((c) => (
                  <div
                    key={c.customer.workspace_id}
                    draggable={draggable}
                    onDragStart={
                      draggable
                        ? (e) => {
                            e.dataTransfer.setData(
                              "text/plain",
                              c.customer.workspace_id
                            );
                            e.dataTransfer.effectAllowed = "move";
                          }
                        : undefined
                    }
                    onClick={() => onCardClick(c.customer.workspace_id)}
                    className={`bg-surface border border-border rounded-md p-2.5 hover:border-border-strong transition-colors ${
                      draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-sm text-fg truncate">
                        {c.customer.company_name ?? c.customer.workspace_name}
                      </div>
                      {c.atRisk ? (
                        <span
                          title={c.atRisk.flags.map((f) => f.label).join(", ")}
                          className="flex-shrink-0 inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-800 dark:text-red-300 whitespace-nowrap"
                        >
                          at-risk
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted mt-1">
                      {fmtCurrency(c.customer.arr)}
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      {renderCardMeta ? (
                        renderCardMeta(c)
                      ) : (
                        <StatusBadge value={c.customer.property_company_status} />
                      )}
                    </div>
                    {onToggleStep ? (
                      c.steps.length === 0 && renderEmptyChecklist ? (
                        renderEmptyChecklist(c)
                      ) : (
                        <StageTodoList
                          steps={c.steps}
                          stageOrder={stageOrder ?? []}
                          currentStage={c.stage ?? c.suggested_stage ?? null}
                          editable={c.editable}
                          onToggle={(stepId) =>
                            onToggleStep(c.customer.workspace_id, stepId)
                          }
                          onEditDueDate={
                            c.checklist_kind === "renewal_stage" || !onEditDueDate
                              ? undefined
                              : (stepId, dueDate) =>
                                  onEditDueDate(
                                    c.customer.workspace_id,
                                    stepId,
                                    dueDate
                                  )
                          }
                          onEditDetails={
                            c.checklist_kind === "renewal_stage" || !onEditDetails
                              ? undefined
                              : (stepId, details) =>
                                  onEditDetails(
                                    c.customer.workspace_id,
                                    stepId,
                                    details
                                  )
                          }
                          onEditTitle={
                            c.checklist_kind === "renewal_stage" || !onEditTitle
                              ? undefined
                              : (stepId, title) =>
                                  onEditTitle(c.customer.workspace_id, stepId, title)
                          }
                          flatGroupTitle={
                            c.checklist_kind === "renewal_stage"
                              ? "Renewal stage"
                              : undefined
                          }
                          companyName={
                            c.customer.company_name ?? c.customer.workspace_name ?? undefined
                          }
                          onAddStep={
                            c.checklist_kind === "renewal_stage" ||
                            !onAddTodo ||
                            !c.customer.hubspot_company_id
                              ? undefined
                              : (group, fields) =>
                                  onAddTodo(c.customer.workspace_id, group, fields)
                          }
                          alwaysShowGroups={
                            c.checklist_kind === "renewal_stage"
                              ? undefined
                              : alwaysShowGroups
                          }
                        />
                      )
                    ) : null}
                    {/* Renewal-stage cards get a second, independent
                        checklist beneath the fixed 5-item one — the
                        same "Live" ongoing group a Q1/Q2/Q3/Q4 card
                        shows, reusing alwaysShowGroups (already board-
                        scoped to just that group) so it still renders
                        at 0/0 with a "+" to create the first one. */}
                    {onToggleStep &&
                    c.checklist_kind === "renewal_stage" &&
                    alwaysShowGroups?.length ? (
                      <StageTodoList
                        steps={c.liveOngoingSteps ?? []}
                        stageOrder={alwaysShowGroups}
                        currentStage={alwaysShowGroups[0]}
                        editable={c.editable}
                        onToggle={(stepId) =>
                          onToggleStep(c.customer.workspace_id, stepId)
                        }
                        onEditDueDate={
                          !onEditDueDate
                            ? undefined
                            : (stepId, dueDate) =>
                                onEditDueDate(c.customer.workspace_id, stepId, dueDate)
                        }
                        onEditDetails={
                          !onEditDetails
                            ? undefined
                            : (stepId, details) =>
                                onEditDetails(c.customer.workspace_id, stepId, details)
                        }
                        onEditTitle={
                          !onEditTitle
                            ? undefined
                            : (stepId, title) =>
                                onEditTitle(c.customer.workspace_id, stepId, title)
                        }
                        companyName={
                          c.customer.company_name ?? c.customer.workspace_name ?? undefined
                        }
                        onAddStep={
                          !onAddTodo || !c.customer.hubspot_company_id
                            ? undefined
                            : (group, fields) =>
                                onAddTodo(c.customer.workspace_id, group, fields)
                        }
                        alwaysShowGroups={alwaysShowGroups}
                      />
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
