"use client";

import { SearchInput } from "../filters";
import { CsmSelector } from "../csm-selector";
import { TabBar } from "../tab-bar";
import { useZendeskOverlay } from "@/lib/data/use-zendesk-overlay";

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  csms: string[];
  zendeskOn: boolean;
  onToggleZendesk: () => void;
}

/**
 * Filter row shared by both Lifecycle sub-boards (Onboarding, Live).
 * Reads almost like a sentence: [Onboarding|Live] for [CSM] and
 * [Zendesk chip] — the Onboarding/Live sub-tabs live here (each board
 * renders its own copy, same duplication CsmSelector/the Zendesk chip
 * already had) so the "which board am I on" control sits right next
 * to "which CSM's book" and "narrowed to which customers", instead of
 * owning a separate row above. Search gets its own row below, since
 * it's a different kind of control (free text, not a toggle/switch).
 *
 * Deliberately without the Status / Prior ESP / Tech stack / Feature
 * usage filters the book view (customer-table.tsx) has — those make
 * sense for a full customer list, not a small Kanban board (a card's
 * own column already carries most of that signal here).
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
    <div className="space-y-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <TabBar
          bare
          tabs={[
            { id: "onboarding", label: "Onboarding" },
            { id: "live", label: "Live" },
          ]}
          defaultTab="live"
          param="sub"
        />
        <span className="text-sm text-muted">for</span>
        <CsmSelector csms={csms} />
        <span className="text-sm text-muted">and</span>
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
      </div>
      <SearchInput
        value={search}
        onChange={onSearchChange}
        placeholder="Search company or workspace…"
        className="w-full"
      />
    </div>
  );
}
