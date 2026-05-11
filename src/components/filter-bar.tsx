"use client";

import { CsmSelector } from "./csm-selector";

interface FilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  csms: string[];
}

/**
 * Top-of-table filter strip — just search and the CSM selector. Deeper
 * filters (feature utilization, ad network) live in their own dedicated
 * panels below this strip so they're more discoverable + multi-select
 * capable. Engagement / status / renewals-in-30d filters are removed
 * since the cohort tabs (renewals, at-risk) already cover those views.
 */
export function FilterBar({
  search,
  onSearchChange,
  csms,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <input
        type="text"
        placeholder="Search company or workspace..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="px-3.5 py-2 bg-surface border border-border rounded-lg text-sm flex-1 min-w-[220px] text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
      />
      <CsmSelector csms={csms} />
    </div>
  );
}
