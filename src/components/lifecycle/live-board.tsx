"use client";

import { useEffect, useMemo, useState } from "react";
import { compareByRenewalDate, type LifecycleCard, type LifecycleStep } from "@/lib/lifecycle/card";
import {
  toggleLifecycleStep,
  patchLifecycleStepDueDate,
  patchLifecycleStepDetails,
  patchLifecycleStepTitle,
  addLifecycleStep,
} from "@/lib/lifecycle/toggle-step";
import { buildRenewalChecklist, setLifecycleStage } from "@/lib/lifecycle/renewal-checklist";
import {
  LIVE_ASSIGNABLE_STAGES,
  LIVE_ONGOING_GROUP,
  MONTHLY_COLUMN,
} from "@/lib/lifecycle/live-quarter";
import { useZendeskOverlay } from "@/lib/data/use-zendesk-overlay";
import { newTodoId } from "@/lib/personal-todos/types";
import { normalizeSlackText } from "@/lib/personal-todos/normalize-text";
import type { AddTodoFields } from "./add-todo-modal";
import { KanbanColumns } from "./kanban-columns";
import { LifecycleCardModal } from "./lifecycle-card-modal";
import { LifecycleFilterBar } from "./lifecycle-filter-bar";
import { fmtDate } from "../format";

// No "Unsorted" column here — unlike Onboarding, this board is fully
// computed (computeLiveQuarter always returns one of these 5 labels,
// never null), so an Unsorted catch-all would only ever sit empty.
// "Q4" is the monthly-billed bucket — see live-quarter.ts's module
// doc comment for why it's kept separate from the Q1→Renewal annual
// countdown instead of folded in.
const LIVE_QUARTER_COLUMNS = ["Q1", "Q2", "Q3", "Renewal", MONTHLY_COLUMN];

interface Props {
  cards: LifecycleCard[];
  /** Every CSM handle in the current book — feeds the filter row's
   *  CsmSelector, same list the book/at-risk/renewals tabs already
   *  pass to theirs. */
  csms: string[];
}

/**
 * Live sub-board — fully computed, not draggable. Every card's
 * `stage` was already decided server-side by
 * src/lib/lifecycle/live-quarter.ts's computeLiveQuarter (days until
 * `contract_renewal`, bucketed into quarters) — no PATCH calls, no
 * optimistic moves, no seeding effect for placement. Once a renewal
 * actually closes and `contract_renewal` rolls forward in the data,
 * the card computes back to Q1 on its own next load — nothing here
 * resets it.
 *
 * What IS interactive is each card's checklist, but which one depends
 * on the column: Q1/Q2/Q3 cards show the "live:" playbook (toggled
 * independently via /api/personal-todos, same as Onboarding's), while
 * "Renewal" column cards show the 5-item renewal-stage checklist —
 * clicking an item there SETS the single `lifecycle_stage` value via
 * /api/customer-overrides instead of toggling an independent to-do
 * (see renewal-checklist.ts for why that's a meaningfully different
 * interaction).
 */
export function LiveBoard({ cards: initialCards, csms }: Props) {
  const [cards, setCards] = useState(initialCards);
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [zendeskOn, setZendeskOn] = useState(false);
  const zendeskOverlay = useZendeskOverlay();

  // useState(initialCards) only seeds state on first mount — switching
  // the CsmSelector calls router.refresh(), which re-runs the server
  // component and hands this component a genuinely new `cards` prop,
  // but without this, the already-mounted board would keep showing
  // the previous CSM's stale local state instead of picking it up.
  useEffect(() => {
    setCards(initialCards);
  }, [initialCards]);

  const columns = useMemo(() => LIVE_QUARTER_COLUMNS, []);

  const visibleCards = useMemo(() => {
    let out = cards;
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((c) => {
        const name = c.customer.company_name ?? c.customer.workspace_name ?? "";
        return name.toLowerCase().includes(q);
      });
    }
    if (zendeskOn && zendeskOverlay) {
      out = out.filter((c) => {
        const wsId = c.customer.workspace_id;
        return wsId ? (zendeskOverlay.rows[wsId]?.total_30d ?? 0) > 0 : false;
      });
    }
    return out;
  }, [cards, search, zendeskOn, zendeskOverlay]);

  const cardsByColumn = useMemo(() => {
    const m = new Map<string, LifecycleCard[]>();
    for (const col of columns) m.set(col, []);
    for (const c of visibleCards) {
      // computeLiveQuarter always returns one of LIVE_QUARTER_COLUMNS
      // — the "Q1" fallback here only guards against a stage value
      // this board's own column list hasn't been updated to include.
      const col = c.stage ?? "Q1";
      const list = m.get(col) ?? m.get("Q1")!;
      list.push(c);
    }
    for (const list of m.values()) list.sort(compareByRenewalDate);
    return m;
  }, [visibleCards, columns]);

  const openCard =
    cards.find((c) => c.customer.workspace_id === openWorkspaceId) ?? null;

  async function handleTogglePlaybookStep(workspaceId: string, stepId: string) {
    const prevCards = cards;
    setCards((prev) =>
      prev.map((c) =>
        c.customer.workspace_id === workspaceId
          ? {
              ...c,
              steps: c.steps.map((s) =>
                s.id === stepId ? { ...s, completed: !s.completed } : s
              ),
            }
          : c
      )
    );
    try {
      await toggleLifecycleStep(stepId);
    } catch {
      setCards(prevCards);
    }
  }

  // Only ever invoked for "playbook"-kind steps — kanban-columns.tsx
  // never wires onEditDueDate for a Renewal-stage card, so there's no
  // checklist_kind branch needed here (unlike handleToggleStep).
  async function handleEditDueDate(
    workspaceId: string,
    stepId: string,
    dueDate: string | null
  ) {
    const prevCards = cards;
    setCards((prev) =>
      prev.map((c) =>
        c.customer.workspace_id === workspaceId
          ? {
              ...c,
              steps: c.steps.map((s) =>
                s.id === stepId ? { ...s, due_date: dueDate } : s
              ),
            }
          : c
      )
    );
    try {
      await patchLifecycleStepDueDate(stepId, dueDate);
    } catch {
      setCards(prevCards);
    }
  }

  // Same reasoning as handleEditDueDate above — never invoked for a
  // Renewal-stage card, so no checklist_kind branch needed.
  async function handleEditDetails(
    workspaceId: string,
    stepId: string,
    details: string | null
  ) {
    const prevCards = cards;
    setCards((prev) =>
      prev.map((c) =>
        c.customer.workspace_id === workspaceId
          ? {
              ...c,
              steps: c.steps.map((s) =>
                s.id === stepId ? { ...s, details } : s
              ),
            }
          : c
      )
    );
    try {
      await patchLifecycleStepDetails(stepId, details);
    } catch {
      setCards(prevCards);
    }
  }

  // Same reasoning as handleEditDueDate above — never invoked for a
  // Renewal-stage card, so no checklist_kind branch needed.
  async function handleEditTitle(workspaceId: string, stepId: string, title: string) {
    const prevCards = cards;
    setCards((prev) =>
      prev.map((c) =>
        c.customer.workspace_id === workspaceId
          ? {
              ...c,
              steps: c.steps.map((s) => (s.id === stepId ? { ...s, title } : s)),
            }
          : c
      )
    );
    try {
      await patchLifecycleStepTitle(stepId, title);
    } catch {
      setCards(prevCards);
    }
  }

  /** On-card "+" (AddTodoModal, via StageTodoList) — same PersonalTodo
   *  shape personal-todos-panel.tsx's composer builds for a
   *  company+group pair, just sourced from the card's own customer
   *  instead of a picked-from-a-dropdown one. Never invoked for a
   *  Renewal-stage card — kanban-columns.tsx gates onAddStep the same
   *  way it already gates onEditDueDate/onEditDetails. The modal
   *  itself already pre-fills the title with "{company} — " (same
   *  autofill the main composer does on company select), so there's
   *  no auto-generated details text here — details is just whatever
   *  the CSM typed into the modal's own notes field, or null. */
  async function handleAddTodo(
    workspaceId: string,
    group: string,
    fields: AddTodoFields
  ) {
    const card = cards.find((c) => c.customer.workspace_id === workspaceId);
    if (!card?.customer.hubspot_company_id) return;
    const title = normalizeSlackText(fields.title).trim();
    if (!title) return;
    const now = new Date().toISOString();
    const newStep: LifecycleStep = {
      id: newTodoId(),
      title,
      completed: false,
      due_date: fields.due_date,
      stage: group,
      details: fields.details,
      completed_at: null,
      surface_at: fields.surface_at,
    };

    const prevCards = cards;
    setCards((prev) =>
      prev.map((c) =>
        c.customer.workspace_id === workspaceId
          ? {
              ...c,
              steps: [...c.steps, newStep],
              totalCount: c.totalCount + 1,
            }
          : c
      )
    );
    try {
      await addLifecycleStep({
        id: newStep.id,
        title,
        details: fields.details,
        due_date: fields.due_date,
        surface_at: fields.surface_at,
        priority: fields.priority,
        source: "slack_assign",
        source_meta: {
          hubspot_company_id: card.customer.hubspot_company_id,
          checklist_group: group,
        },
        completed_at: null,
        created_at: now,
        updated_at: now,
      });
    } catch {
      setCards(prevCards);
    }
  }

  async function handleSetRenewalStage(workspaceId: string, stageLabel: string) {
    const prevCards = cards;
    const nextSteps = buildRenewalChecklist(stageLabel);
    setCards((prev) =>
      prev.map((c) =>
        c.customer.workspace_id === workspaceId
          ? {
              ...c,
              steps: nextSteps,
              completedCount: nextSteps.filter((s) => s.completed).length,
              totalCount: nextSteps.length,
            }
          : c
      )
    );
    try {
      await setLifecycleStage(workspaceId, stageLabel);
    } catch {
      setCards(prevCards);
    }
  }

  function handleToggleStep(workspaceId: string, stepId: string) {
    const card = cards.find((c) => c.customer.workspace_id === workspaceId);
    if (card?.checklist_kind === "renewal_stage") {
      // stepId is the stage label itself for this checklist kind —
      // see renewal-checklist.ts's buildRenewalChecklist (id === label).
      void handleSetRenewalStage(workspaceId, stepId);
    } else {
      void handleTogglePlaybookStep(workspaceId, stepId);
    }
  }

  return (
    <>
      <LifecycleFilterBar
        search={search}
        onSearchChange={setSearch}
        csms={csms}
        zendeskOn={zendeskOn}
        onToggleZendesk={() => setZendeskOn((v) => !v)}
      />
      <KanbanColumns
        columns={columns}
        cardsByColumn={cardsByColumn}
        stageOrder={LIVE_ASSIGNABLE_STAGES}
        alwaysShowGroups={[LIVE_ONGOING_GROUP]}
        draggable={false}
        onCardClick={setOpenWorkspaceId}
        onToggleStep={handleToggleStep}
        onEditDueDate={(workspaceId, stepId, dueDate) =>
          void handleEditDueDate(workspaceId, stepId, dueDate)
        }
        onEditDetails={(workspaceId, stepId, details) =>
          void handleEditDetails(workspaceId, stepId, details)
        }
        onEditTitle={(workspaceId, stepId, title) =>
          void handleEditTitle(workspaceId, stepId, title)
        }
        onAddTodo={(workspaceId, group, fields) =>
          void handleAddTodo(workspaceId, group, fields)
        }
        renderCardMeta={(c) =>
          c.stage === MONTHLY_COLUMN ? (
            <span className="text-xs text-subtle">Monthly billing</span>
          ) : (
            <span className="text-xs text-subtle">
              Renews {fmtDate(c.customer.contract_renewal)}
            </span>
          )
        }
      />
      {openCard ? (
        <LifecycleCardModal card={openCard} onClose={() => setOpenWorkspaceId(null)} />
      ) : null}
    </>
  );
}
