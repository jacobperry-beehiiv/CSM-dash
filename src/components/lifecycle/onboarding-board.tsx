"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compareByRenewalDate, type LifecycleCard } from "@/lib/lifecycle/card";
import { toggleLifecycleStep } from "@/lib/lifecycle/toggle-step";
import { KanbanColumns, UNSORTED } from "./kanban-columns";
import { LifecycleCardModal } from "./lifecycle-card-modal";
import { fmtDate } from "../format";

interface Props {
  cards: LifecycleCard[];
  /** The board's fixed column labels, in order — ONBOARDING_STAGES
   *  from src/lib/lifecycle/onboarding.ts, passed down rather than
   *  imported here so the server-computed cards and the client
   *  columns can never drift. "Unsorted" is added by this component
   *  — leftmost, per product decision, unlike the old Renewal board's
   *  trailing one. */
  stages: string[];
}

async function patchOnboardingStage(workspaceId: string, stage: string | null) {
  const r = await fetch("/api/customer-overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace_id: workspaceId,
      onboarding_lifecycle_stage: stage,
    }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${r.status}`);
  }
}

/**
 * Onboarding sub-board — manual, drag-and-drop. A card with no
 * placement yet shows a one-time suggested column (see
 * src/lib/lifecycle/onboarding.ts), which this component silently
 * persists on mount — after that first write it's an ordinary
 * manually-placed card, same as any other drag. Dragging to the
 * team's configured terminal stage (default "Launch") is how a
 * customer hands off to the Live board — that's a page-level routing
 * decision (src/app/csm/page.tsx re-fetches on next load), not
 * something this component does itself.
 */
export function OnboardingBoard({ cards: initialCards, stages }: Props) {
  const [cards, setCards] = useState(initialCards);
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);
  const seeded = useRef(new Set<string>());

  useEffect(() => {
    for (const c of cards) {
      const id = c.customer.workspace_id;
      if (c.stage || !c.suggested_stage || seeded.current.has(id)) continue;
      seeded.current.add(id);
      const stage = c.suggested_stage;
      patchOnboardingStage(id, stage)
        .then(() => {
          setCards((prev) =>
            prev.map((card) =>
              card.customer.workspace_id === id
                ? { ...card, stage, suggested_stage: null }
                : card
            )
          );
        })
        .catch(() => {
          // Leave it as a suggestion-only card; it'll retry seeding
          // next time the board mounts (seeded.current is per-mount).
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  const columns = useMemo(() => [UNSORTED, ...stages], [stages]);

  const cardsByColumn = useMemo(() => {
    const m = new Map<string, LifecycleCard[]>();
    for (const col of columns) m.set(col, []);
    for (const c of cards) {
      const col = c.stage ?? c.suggested_stage ?? UNSORTED;
      const list = m.get(col) ?? m.get(UNSORTED)!;
      list.push(c);
    }
    for (const list of m.values()) list.sort(compareByRenewalDate);
    return m;
  }, [cards, columns]);

  const openCard =
    cards.find((c) => c.customer.workspace_id === openWorkspaceId) ?? null;

  async function moveCard(workspaceId: string, targetColumn: string) {
    const prevCards = cards;
    const nextStage = targetColumn === UNSORTED ? null : targetColumn;
    setCards((prev) =>
      prev.map((c) =>
        c.customer.workspace_id === workspaceId
          ? { ...c, stage: nextStage, suggested_stage: null }
          : c
      )
    );
    try {
      await patchOnboardingStage(workspaceId, nextStage);
    } catch {
      setCards(prevCards);
    }
  }

  async function handleToggleStep(workspaceId: string, stepId: string) {
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

  return (
    <>
      <KanbanColumns
        columns={columns}
        cardsByColumn={cardsByColumn}
        stageOrder={stages}
        draggable
        onDrop={(workspaceId, col) => void moveCard(workspaceId, col)}
        onCardClick={setOpenWorkspaceId}
        onToggleStep={(workspaceId, stepId) =>
          void handleToggleStep(workspaceId, stepId)
        }
        renderCardMeta={(c) => {
          const isPastDue =
            (c.customer.property_company_status ?? "").trim().toLowerCase() ===
            "past due";
          return (
            <>
              <span className="text-xs text-subtle">
                Renews {fmtDate(c.customer.contract_renewal)}
              </span>
              {isPastDue ? (
                <span className="flex-shrink-0 inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-800 dark:text-red-300 whitespace-nowrap">
                  past due
                </span>
              ) : null}
            </>
          );
        }}
      />
      {openCard ? (
        <LifecycleCardModal card={openCard} onClose={() => setOpenWorkspaceId(null)} />
      ) : null}
    </>
  );
}
