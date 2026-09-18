"use client";

import { FilterBar, SearchInput } from "../filters";
import { CsmSelector } from "../csm-selector";
import { useZendeskOverlay } from "@/lib/data/use-zendesk-overlay";

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  csms: string[];
  zendeskOn: boolean;
  onToggleZendesk: () => void;
}

/**
 * Filter row shared by both Lifecycle sub-boards (Onboarding, Live) —
 * search + CSM switcher + "Has Zendesk tickets" chip, same visual
 * pieces the book view (customer-table.tsx) already uses, deliberately
 * without the Status / Prior ESP / Tech stack / Feature usage filters
 * that make sense for a full customer list but not a small Kanban
 * board (per product decision — a card's board/column already carries
 * most of that signal here).
 *
 * Purely presentational — each board owns its own `search` state and
 * derives its own Zendesk-workspace-id set (via the same
 * `useZendeskOverlay` hook, module-cached so calling it here too costs
 * nothing extra) to actually filter its `cards` array. This component
 * only renders the controls and the chip's own count/spinner.
 */
export function LifecycleFilterBar({
  search,
  onSearchChange,
  csms,
  zendeskOn,
  onToggleZendesk,
}: Props) {
  const overlay = useZendeskOverlay();
  const zendeskCount = overlay
    ? Object.values(overlay.rows).filter((r) => r.total_30d > 0).length
    : null;

  return (
    <FilterBar>
      <SearchInput
        value={search}
        onChange={onSearchChange}
        placeholder="Search company or workspace…"
      />
      <CsmSelector csms={csms} />
      <button
        type="button"
        onClick={onToggleZendesk}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors ${
          zendeskOn
            ? "bg-accent text-accent-fg border-accent font-medium"
            : "bg-surface text-fg border-border-strong hover:bg-canvas"
        }`}
        title="Show only customers with at least one Zendesk ticket logged in the last 30 days."
      >
        <span>🎫 Has Zendesk tickets (30d)</span>
        {zendeskOn ? (
          zendeskCount != null ? (
            <span className="tabular-nums">({zendeskCount})</span>
          ) : (
            <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          )
        ) : null}
      </button>
    </FilterBar>
  );
}
