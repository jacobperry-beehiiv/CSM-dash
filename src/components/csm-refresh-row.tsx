"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";

/**
 * Client-side CSM cell + refresh affordance for the customer detail
 * panel's Contact section. Pulls fresh assignment from HubSpot on
 * demand (POST /api/customer-overrides/refresh-csm), shows a
 * before/after diff if it changes, and renders a "live" pill so the
 * viewer knows the value didn't come from the nightly Metabase
 * snapshot.
 *
 * Why this exists: HubSpot → Metabase → snapshot is a 24-48h pipeline.
 * When someone reassigns a customer in HubSpot, the dashboard
 * shouldn't have to wait — a single button gets the right name on
 * screen immediately.
 */

interface RefreshResponse {
  before: {
    customer_success_manager: string | null;
    customer_success_manager_email: string | null;
  };
  after: {
    customer_success_manager: string | null;
    customer_success_manager_email: string | null;
  } | null;
  owner_name?: string | null;
  csm_refreshed_at?: string | null;
  note?: string;
  error?: string;
}

interface Props {
  customer: Customer;
}

export function CsmRefreshRow({ customer }: Props) {
  // The initial display reflects whatever loadCustomers() handed us
  // (snapshot value, possibly already-overridden). On refresh we
  // overlay the live HubSpot value so the cell updates without a
  // full page reload.
  const [displayName, setDisplayName] = useState<string | null>(
    customer.customer_success_manager ?? null
  );
  const [displayEmail, setDisplayEmail] = useState<string | null>(
    customer.customer_success_manager_email ?? null
  );
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function refresh() {
    if (!customer.workspace_id) return;
    setBusy(true);
    setError(null);
    setDiff(null);
    setNote(null);
    try {
      const r = await fetch("/api/customer-overrides/refresh-csm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: customer.workspace_id }),
      });
      const j = (await r.json()) as RefreshResponse;
      if (!r.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      if (j.note) {
        setNote(j.note);
        return;
      }
      if (!j.after) return;
      // Update the live display + capture the diff so the UI can show
      // "Was: olivia chen · Now: jacob perry" inline.
      const beforeLabel =
        j.before.customer_success_manager?.replace(/_/g, " ") ?? "unassigned";
      const afterLabel =
        j.after.customer_success_manager?.replace(/_/g, " ") ?? "unassigned";
      setDisplayName(j.after.customer_success_manager);
      setDisplayEmail(j.after.customer_success_manager_email);
      setRefreshedAt(j.csm_refreshed_at ?? null);
      if (beforeLabel !== afterLabel) {
        setDiff({ from: beforeLabel, to: afterLabel });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  const humanized = displayName?.replace(/_/g, " ") ?? "—";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg break-words">
          {humanized}
          {refreshedAt ? (
            <span
              className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200 align-baseline"
              title={`Refreshed from HubSpot at ${refreshedAt}`}
            >
              <span aria-hidden>●</span>
              live
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={(e) => {
            // Section header wraps the body in a button when used as
            // a collapsible — stop propagation so clicking the refresh
            // chip doesn't collapse the whole Contact section.
            e.stopPropagation();
            void refresh();
          }}
          disabled={busy || !customer.workspace_id}
          className="text-[11px] px-1.5 py-0.5 border border-border-strong rounded hover:bg-canvas disabled:opacity-50"
          title="Pull the current owner from HubSpot and patch this row without waiting for the next nightly snapshot."
        >
          {busy ? "Refreshing…" : "🔄 HubSpot"}
        </button>
      </div>
      {displayEmail ? (
        <div className="text-[11px] text-subtle truncate" title={displayEmail}>
          {displayEmail}
        </div>
      ) : null}
      {diff ? (
        <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
          Was: {diff.from} · Now: <strong>{diff.to}</strong>
        </div>
      ) : null}
      {note ? (
        <div className="text-[11px] text-muted">{note}</div>
      ) : null}
      {error ? (
        <div className="text-[11px] text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
