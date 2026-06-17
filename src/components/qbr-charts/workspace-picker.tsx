"use client";

import { useMemo, useState } from "react";

/**
 * Workspace dropdown for the QBR Charts tab.
 *
 * Defaults to the logged-in CSM's book — the same filter the rest of
 * the dashboard applies. Admin viewers get a "Show all workspaces"
 * toggle that flips the option list to every workspace in the book,
 * not just their own. The csm prop is the effective filter (null
 * means the page is already showing everyone — admin or "?csm=all").
 *
 * The toggle deliberately lives on the picker, not on the page query
 * string: the rest of the dashboard's scoping is independent of which
 * workspace you happen to be charting, and we don't want flipping
 * "All" here to widen the at-risk / book / deliverability views too.
 */
export interface WorkspaceOption {
  workspace_id: string;
  workspace_name: string | null;
  customer_success_manager: string | null;
}

export function WorkspacePicker({
  workspaces,
  csm,
  isAdmin,
  value,
  onChange,
  disabled,
}: {
  workspaces: WorkspaceOption[];
  csm: string | null;
  isAdmin: boolean;
  value: string;
  onChange: (workspaceId: string) => void;
  disabled?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  const visible = useMemo(() => {
    const filtered =
      showAll || !csm
        ? workspaces
        : workspaces.filter((w) => w.customer_success_manager === csm);
    return [...filtered].sort((a, b) => {
      const an = a.workspace_name?.toLowerCase() ?? "";
      const bn = b.workspace_name?.toLowerCase() ?? "";
      return an.localeCompare(bn);
    });
  }, [workspaces, csm, showAll]);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-muted">
          Workspace
          <span className="text-red-600 ml-0.5">*</span>
        </span>
        {isAdmin && csm ? (
          <label className="text-[10px] text-muted flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="h-3 w-3"
            />
            All workspaces
          </label>
        ) : null}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || visible.length === 0}
        className="mt-1 w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg disabled:opacity-50"
      >
        <option value="">
          {visible.length === 0
            ? "No workspaces in scope"
            : `Select a workspace (${visible.length})`}
        </option>
        {visible.map((w) => (
          <option key={w.workspace_id} value={w.workspace_id}>
            {w.workspace_name ?? w.workspace_id}
            {showAll && w.customer_success_manager
              ? ` — ${w.customer_success_manager.replace(/_/g, " ")}`
              : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
