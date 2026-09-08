"use client";

import { useMemo, useState } from "react";
import { fmtDate } from "../format";
import type { UnmatchedNeed } from "@/lib/data/enterprise-requests-types";

interface WorkspaceOption {
  workspace_id: string;
  label: string;
  csm: string | null;
}

interface Props {
  unmatched: UnmatchedNeed[];
  /** Existing `linear_customer_id → workspace_id | "__skipped"` map,
   *  rendered as an "already handled" badge so admins can see the
   *  queue's history without re-approving anything. */
  manualMap: Record<string, string>;
  workspaceOptions: WorkspaceOption[];
  lastSyncedAt: string;
}

interface RowState {
  choice: string; // "" | workspace_id | "__skipped"
  saving: boolean;
  saved: boolean;
  error: string | null;
}

const SKIP_VALUE = "__skipped";

export function UnmatchedReview({
  unmatched,
  manualMap,
  workspaceOptions,
  lastSyncedAt,
}: Props) {
  // Dedupe: an unmatched blob can carry multiple need-rows for the
  // same Linear customer. Keep one row per customer for the review
  // table but keep the first need_body as the preview text.
  const uniqueUnmatched = useMemo(() => {
    const seen = new Map<string, UnmatchedNeed>();
    for (const u of unmatched) {
      if (!seen.has(u.linear_customer_id)) seen.set(u.linear_customer_id, u);
    }
    return [...seen.values()].sort((a, b) =>
      a.linear_customer_name.localeCompare(b.linear_customer_name)
    );
  }, [unmatched]);

  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const initial: Record<string, RowState> = {};
    for (const u of uniqueUnmatched) {
      initial[u.linear_customer_id] = {
        choice: manualMap[u.linear_customer_id] ?? "",
        saving: false,
        saved: Boolean(manualMap[u.linear_customer_id]),
        error: null,
      };
    }
    return initial;
  });

  async function save(id: string) {
    const state = rows[id];
    if (!state || !state.choice) return;
    setRows((prev) => ({
      ...prev,
      [id]: { ...prev[id], saving: true, error: null },
    }));
    try {
      const r = await fetch("/api/enterprise-requests/unmatched/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linear_customer_id: id,
          workspace_id: state.choice,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setRows((prev) => ({
        ...prev,
        [id]: { ...prev[id], saving: false, saved: true, error: null },
      }));
    } catch (e) {
      setRows((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          saving: false,
          error: e instanceof Error ? e.message : "save failed",
        },
      }));
    }
  }

  if (uniqueUnmatched.length === 0) {
    return (
      <p className="text-sm text-muted italic">
        Nothing pending — every Linear customer with attached
        customer_needs resolved to a dash workspace on the last sync.
      </p>
    );
  }

  return (
    <div>
      <p className="text-xs text-subtle mb-3">
        Last sync: {fmtDate(lastSyncedAt)} · {uniqueUnmatched.length} unique
        unmatched Linear customer{uniqueUnmatched.length === 1 ? "" : "s"}.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full text-sm">
          <thead className="bg-canvas text-xs text-muted uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Linear customer</th>
              <th className="text-left px-3 py-2">Signals</th>
              <th className="text-left px-3 py-2">Need preview</th>
              <th className="text-left px-3 py-2 w-72">Map to workspace</th>
              <th className="text-left px-3 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {uniqueUnmatched.map((u) => {
              const state = rows[u.linear_customer_id];
              const alreadyApproved =
                state.saved && state.choice && state.choice !== SKIP_VALUE;
              const alreadySkipped =
                state.saved && state.choice === SKIP_VALUE;
              return (
                <tr
                  key={u.linear_customer_id}
                  className="border-t border-border align-top"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-fg">
                      {u.linear_customer_name}
                    </div>
                    <div className="text-[10px] text-subtle">
                      first seen {fmtDate(u.first_seen_at)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">
                    {u.external_ids.length > 0 ? (
                      <div>
                        <span className="text-subtle">IDs:</span>{" "}
                        {u.external_ids.slice(0, 3).join(", ")}
                        {u.external_ids.length > 3
                          ? ` +${u.external_ids.length - 3}`
                          : ""}
                      </div>
                    ) : null}
                    {u.domains.length > 0 ? (
                      <div>
                        <span className="text-subtle">Domains:</span>{" "}
                        {u.domains.slice(0, 3).join(", ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted max-w-md">
                    <div className="line-clamp-3">
                      {u.need_body || (
                        <span className="italic">no body</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={state.choice}
                      onChange={(e) =>
                        setRows((prev) => ({
                          ...prev,
                          [u.linear_customer_id]: {
                            ...prev[u.linear_customer_id],
                            choice: e.target.value,
                            saved: false,
                          },
                        }))
                      }
                      className="w-full px-2 py-1 text-xs border border-border-strong rounded bg-surface"
                    >
                      <option value="">— pick a workspace —</option>
                      <option value={SKIP_VALUE}>
                        Skip (not a dash customer)
                      </option>
                      <optgroup label="Workspaces">
                        {workspaceOptions.map((w) => (
                          <option
                            key={w.workspace_id}
                            value={w.workspace_id}
                          >
                            {w.label}
                            {w.csm ? ` — ${w.csm.replace(/_/g, " ")}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    {alreadyApproved ? (
                      <div className="text-[10px] text-emerald-700 dark:text-emerald-300 mt-1">
                        ✓ Approved — will apply on next sync.
                      </div>
                    ) : alreadySkipped ? (
                      <div className="text-[10px] text-slate-700 dark:text-slate-300 mt-1">
                        ✓ Skipped — hidden from queue next sync.
                      </div>
                    ) : null}
                    {state.error ? (
                      <div className="text-[10px] text-red-700 dark:text-red-300 mt-1">
                        {state.error}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => save(u.linear_customer_id)}
                      disabled={!state.choice || state.saving}
                      className="px-2 py-1 text-xs rounded border border-border-strong hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {state.saving ? "Saving…" : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
