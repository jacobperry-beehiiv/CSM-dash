"use client";

import { useState } from "react";
import { fmtDate } from "../format";
import type { OrphanedShipment } from "@/lib/data/enterprise-requests-types";

interface Props {
  orphans: OrphanedShipment[];
  lastSyncedAt: string;
}

interface RowState {
  saving: boolean;
  status: OrphanedShipment["status"];
  error: string | null;
}

const CHANNEL_LABEL: Record<OrphanedShipment["source_channel"], string> = {
  devs_shipped: "#devs-shipped",
  changelog: "#topic-product-changelog",
};

export function OrphansReview({ orphans, lastSyncedAt }: Props) {
  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const initial: Record<string, RowState> = {};
    for (const o of orphans) {
      initial[o.ship_permalink] = {
        saving: false,
        status: o.status,
        error: null,
      };
    }
    return initial;
  });

  async function setStatus(
    permalink: string,
    status: OrphanedShipment["status"]
  ) {
    setRows((prev) => ({
      ...prev,
      [permalink]: { ...prev[permalink], saving: true, error: null },
    }));
    try {
      const r = await fetch("/api/enterprise-requests/orphans/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ship_permalink: permalink, status }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setRows((prev) => ({
        ...prev,
        [permalink]: { saving: false, status, error: null },
      }));
    } catch (e) {
      setRows((prev) => ({
        ...prev,
        [permalink]: {
          ...prev[permalink],
          saving: false,
          error: e instanceof Error ? e.message : "save failed",
        },
      }));
    }
  }

  const pending = orphans.filter((o) => rows[o.ship_permalink].status === "pending");
  const handled = orphans.filter((o) => rows[o.ship_permalink].status !== "pending");

  if (orphans.length === 0) {
    return (
      <p className="text-sm text-muted italic">
        Nothing pending — the shipped-sweep matched every hit to a
        snapshot row within the 14-day grace window.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-subtle">
        Last sweep: {fmtDate(lastSyncedAt)} · {pending.length} pending ·{" "}
        {handled.length} handled.
      </p>
      {pending.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-fg mb-2">Pending</h2>
          <OrphanTable
            rows={pending}
            rowStates={rows}
            onSetStatus={setStatus}
          />
        </section>
      ) : null}
      {handled.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-muted mb-2">
            Handled ({handled.length})
          </h2>
          <OrphanTable
            rows={handled}
            rowStates={rows}
            onSetStatus={setStatus}
          />
        </section>
      ) : null}
    </div>
  );
}

function OrphanTable({
  rows,
  rowStates,
  onSetStatus,
}: {
  rows: OrphanedShipment[];
  rowStates: Record<string, RowState>;
  onSetStatus: (
    permalink: string,
    status: OrphanedShipment["status"]
  ) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-sm">
        <thead className="bg-canvas text-xs text-muted uppercase tracking-wide">
          <tr>
            <th className="text-left px-3 py-2">Source</th>
            <th className="text-left px-3 py-2">Signal</th>
            <th className="text-left px-3 py-2">First seen</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-left px-3 py-2 w-56">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const state = rowStates[o.ship_permalink];
            return (
              <tr
                key={o.ship_permalink}
                className="border-t border-border align-top"
              >
                <td className="px-3 py-2 text-xs">
                  <div className="text-fg font-medium">
                    {CHANNEL_LABEL[o.source_channel]}
                  </div>
                  <a
                    href={o.ship_permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Open Slack thread ↗
                  </a>
                </td>
                <td className="px-3 py-2 text-xs">
                  {o.linear_key ? (
                    <div className="text-fg">
                      <span className="text-subtle">Linear:</span>{" "}
                      {o.linear_key}
                    </div>
                  ) : null}
                  {o.feature_name ? (
                    <div className="text-fg">
                      <span className="text-subtle">Feature:</span>{" "}
                      {o.feature_name}
                    </div>
                  ) : null}
                  {!o.linear_key && !o.feature_name ? (
                    <div className="text-muted italic">no metadata</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted">
                  {fmtDate(o.first_seen_at)}
                </td>
                <td className="px-3 py-2 text-xs">
                  <StatusPill status={state.status} />
                </td>
                <td className="px-3 py-2 text-xs">
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        onSetStatus(o.ship_permalink, "not_customer_facing")
                      }
                      disabled={
                        state.saving ||
                        state.status === "not_customer_facing"
                      }
                      className="px-2 py-1 rounded border border-border-strong hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Not customer-facing
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onSetStatus(o.ship_permalink, "dismissed")
                      }
                      disabled={
                        state.saving || state.status === "dismissed"
                      }
                      className="px-2 py-1 rounded border border-border-strong hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Dismiss
                    </button>
                    {state.status !== "pending" ? (
                      <button
                        type="button"
                        onClick={() =>
                          onSetStatus(o.ship_permalink, "pending")
                        }
                        disabled={state.saving}
                        className="px-2 py-1 rounded border border-border-strong hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-subtle"
                      >
                        Re-open
                      </button>
                    ) : null}
                  </div>
                  {state.error ? (
                    <div className="mt-1 text-[10px] text-red-700 dark:text-red-300">
                      {state.error}
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: OrphanedShipment["status"] }) {
  if (status === "pending") {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-amber-400 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-200">
        PENDING
      </span>
    );
  }
  if (status === "not_customer_facing") {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-slate-400 bg-slate-100 dark:bg-slate-500/10 text-slate-700 dark:text-slate-300">
        NOT CUSTOMER-FACING
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-slate-400 bg-slate-100 dark:bg-slate-500/10 text-slate-700 dark:text-slate-300">
      DISMISSED
    </span>
  );
}
