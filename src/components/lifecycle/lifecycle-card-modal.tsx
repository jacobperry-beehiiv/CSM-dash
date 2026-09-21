"use client";

import type { LifecycleCard } from "@/lib/lifecycle/card";
import { CustomerDetailPanel } from "../customer-detail-panel";

interface Props {
  card: LifecycleCard;
  onClose: () => void;
}

/**
 * Shared modal for all three Lifecycle sub-boards. Modal shell mirrors
 * OutreachModal's (backdrop + centered panel). The to-do checklist
 * lives on the card face itself (kanban-columns.tsx's StageTodoList),
 * not here — this modal is just the full customer detail, opened by
 * clicking anywhere on a card outside its checklist.
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
          <CustomerDetailPanel customer={card.customer} showPaidSubs />
        </div>
      </div>
    </div>
  );
}
