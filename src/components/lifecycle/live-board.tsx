"use client";

import { useMemo, useState } from "react";
import { compareByRenewalDate, type LifecycleCard } from "@/lib/lifecycle/card";
import { toggleLifecycleStep } from "@/lib/lifecycle/toggle-step";
import { buildRenewalChecklist, setLifecycleStage } from "@/lib/lifecycle/renewal-checklist";
import { LIVE_ASSIGNABLE_STAGES } from "@/lib/lifecycle/live-quarter";
import { KanbanColumns, UNSORTED } from "./kanban-columns";
import { LifecycleCardModal } from "./lifecycle-card-modal";
import { fmtDate } from "../format";

const LIVE_QUARTER_COLUMNS = ["Q1", "Q2", "Q3", "Renewal"];

interface Props {
  cards: LifecycleCard[];
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
export function LiveBoard({ cards: initialCards }: Props) {
  const [cards, setCards] = useState(initialCards);
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);

  const columns = useMemo(() => [UNSORTED, ...LIVE_QUARTER_COLUMNS], []);

  const cardsByColumn = useMemo(() => {
    const m = new Map<string, LifecycleCard[]>();
    for (const col of columns) m.set(col, []);
    for (const c of cards) {
      const col = c.stage ?? UNSORTED;
      const list = m.get(col) ?? m.get(UNSORTED)!;
      list.push(c);
    }
    for (const list of m.values()) list.sort(compareByRenewalDate);
    return m;
  }, [cards, columns]);

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
      <KanbanColumns
        columns={columns}
        cardsByColumn={cardsByColumn}
        stageOrder={LIVE_ASSIGNABLE_STAGES}
        draggable={false}
        onCardClick={setOpenWorkspaceId}
        onToggleStep={handleToggleStep}
        renderCardMeta={(c) => (
          <span className="text-xs text-subtle">
            Renews {fmtDate(c.customer.contract_renewal)}
          </span>
        )}
      />
      {openCard ? (
        <LifecycleCardModal card={openCard} onClose={() => setOpenWorkspaceId(null)} />
      ) : null}
    </>
  );
}
