"use client";

import type { LifecycleCard } from "@/lib/lifecycle/card";
import { CustomerDetailPanel } from "../customer-detail-panel";
import { FlagResolutionCheckboxes } from "../flag-resolution-checkboxes";

interface Props {
  card: LifecycleCard;
  onClose: () => void;
}

/** Same badge coloring the at-risk table itself uses per flag code —
 *  duplicated there too (flag-resolution-checkboxes.tsx, at-risk-
 *  table.tsx); kept as its own tiny copy here rather than exporting
 *  one shared constant across three files for four lines of styling. */
const FLAG_COLORS: Record<string, string> = {
  A: "bg-blue-100 text-blue-800 dark:text-blue-300",
  B: "bg-indigo-100 text-indigo-800",
  C: "bg-amber-100 text-amber-800 dark:text-amber-300",
  D: "bg-red-100 text-red-800 dark:text-red-300",
  E: "bg-orange-100 text-orange-800",
  F: "bg-purple-100 text-purple-800",
  G: "bg-rose-100 text-rose-800",
  H: "bg-orange-100 text-orange-800",
};

/**
 * Shared modal for all three Lifecycle sub-boards. Modal shell mirrors
 * OutreachModal's (backdrop + centered panel). The to-do checklist
 * lives on the card face itself (kanban-columns.tsx's StageTodoList),
 * not here — this modal is just the full customer detail, opened by
 * clicking anywhere on a card outside its checklist (including the
 * card's own at-risk pill, which calls the same onCardClick this modal
 * is already wired to).
 *
 * When the customer is at-risk, the same "why this account is
 * flagged" + "mark resolved" block the at-risk table's expanded row
 * shows (at-risk-table.tsx) renders here too, via CustomerDetailPanel's
 * existing `topSlot` — no new UI, just the same block plus the same
 * reusable FlagResolutionCheckboxes component in a second place.
 */
export function LifecycleCardModal({ card, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border sticky top-0 bg-surface">
          <h3 className="font-semibold text-fg">
            {card.customer.company_name ?? card.customer.workspace_name}
          </h3>
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none flex-shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-4">
          <CustomerDetailPanel
            customer={card.customer}
            showPaidSubs
            topSlot={
              card.atRisk ? (
                <div className="space-y-3 mb-4">
                  <div className="rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300 mb-2">
                      Why this account is flagged
                    </h4>
                    <ul className="space-y-1">
                      {card.atRisk.flags.map((f) => (
                        <li key={f.code} className="text-sm text-fg">
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold mr-2 ${
                              FLAG_COLORS[f.code] ?? "bg-surface-2"
                            }`}
                          >
                            {f.code} · {f.label}
                          </span>
                          <span className="break-words">{f.detail}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-amber-900 dark:text-amber-200">
                      <strong>Recommended action:</strong>{" "}
                      {card.atRisk.recommendedAction}
                    </p>
                  </div>
                  <FlagResolutionCheckboxes
                    workspaceId={card.customer.workspace_id}
                    flags={card.atRisk.flags}
                  />
                </div>
              ) : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
