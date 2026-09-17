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
  /** HubSpot company name — the primary identifier the customer
   *  table + deliverability tab surface. Preferred over
   *  workspace_name for the dropdown label so accounts read the
   *  same across every tab. Falls back to workspace_name / id. */
  company_name: string | null;
  /** Owner email, threaded through so downstream consumers (e.g.
   *  the QBR date-window auto-fill) can look up the same customer
   *  without a second lookup against the book. */
  owner_email: string | null;
  /** Upcoming HubSpot contract-renewal date (ISO), when set.
   *  Powers the QBR tab's auto-fill of the start/end window. */
  contract_renewal: string | null;
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
    // Sort by the same primary label the option renders — the CSM
    // reads "Company · Workspace" and expects alphabetical to match.
    return [...filtered].sort((a, b) => {
      const an = (a.company_name ?? a.workspace_name ?? "").toLowerCase();
      const bn = (b.company_name ?? b.workspace_name ?? "").toLowerCase();
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
        {visible.map((w) => {
          // Match the /csm All-assigned + deliverability formatting:
          // company_name is primary, workspace_name is a muted
          // suffix only when it differs. Falls back to
          // workspace_name / id when company_name is missing.
          const primary = w.company_name ?? w.workspace_name ?? w.workspace_id;
          const secondary =
            w.workspace_name && w.workspace_name !== w.company_name
              ? w.workspace_name
              : null;
          const csmSuffix =
            showAll && w.customer_success_manager
              ? ` — ${w.customer_success_manager.replace(/_/g, " ")}`
              : "";
          return (
            <option key={w.workspace_id} value={w.workspace_id}>
              {primary}
              {secondary ? ` · ${secondary}` : ""}
              {csmSuffix}
            </option>
          );
        })}
      </select>
    </div>
  );
}
