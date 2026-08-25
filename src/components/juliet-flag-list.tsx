"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Customer } from "@/lib/types";
import type {
  JulietFlag,
  JulietFlagStatus,
} from "@/lib/data/juliet-flags-store";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RiskLevelChip } from "./risk-level-chip";
import { fmtCurrency, fmtDate } from "./format";
import Link from "next/link";

/**
 * "Flagged for Juliet" queue view. Groups the flagged workspaces
 * (loaded server-side in /csm page.tsx, passed in as `rows`) into
 * per-customer cards, each with the full CustomerDetailPanel so
 * Juliet gets ARR, dates, HubSpot contacts, publications, notes —
 * the same rich context every other detail-panel surface exposes.
 *
 * Marked "use client" because CustomerDetailPanel passes function
 * props (renderReadOnly) into MappedFieldEditor. Server → client
 * function-prop hand-off isn't allowed in the RSC boundary, so this
 * whole subtree needs to render on the client. The parent server
 * component owns data loading; this view just presents it.
 *
 * Empty state renders a helpful nudge instead of a blank tab.
 *
 * No "clear from Juliet's side" affordance yet — the shared
 * JulietFlagControl inside each panel already handles that. If she
 * clears it from within the expanded panel, router.refresh() drops
 * the card on the next render.
 */
interface FlaggedRow {
  customer: Customer;
  flag: JulietFlag;
}

const STATUS_ORDER: Record<JulietFlagStatus, number> = {
  open: 0,
  outreach_made: 1,
  resolved: 2,
};

const STATUS_LABEL: Record<JulietFlagStatus, string> = {
  open: "Open",
  outreach_made: "Outreach made",
  resolved: "Resolved",
};

const STATUS_STYLE: Record<JulietFlagStatus, string> = {
  open: "bg-purple-100 text-purple-900 dark:bg-purple-500/20 dark:text-purple-100 border-purple-300 dark:border-purple-500/40",
  outreach_made:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-100 border-emerald-300 dark:border-emerald-500/40",
  resolved:
    "bg-surface-2 text-muted border-border",
};

export function JulietFlagList({ rows }: { rows: FlaggedRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Optimistic overlay so the chip flips instantly while the POST +
   *  router.refresh() round-trip. Keyed by workspace_id → the pending
   *  status. Cleared when the props from the server catch up. */
  const [optimistic, setOptimistic] = useState<
    Record<string, JulietFlagStatus>
  >({});

  async function setStatus(workspaceId: string, status: JulietFlagStatus) {
    setError(null);
    setOptimistic((prev) => ({ ...prev, [workspaceId]: status }));
    try {
      const r = await fetch("/api/juliet-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, status }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status update failed");
      // Revert the optimistic overlay so the chip snaps back.
      setOptimistic((prev) => {
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
    }
  }

  function effectiveStatus(row: FlaggedRow): JulietFlagStatus {
    const wsId = row.customer.workspace_id;
    if (wsId && optimistic[wsId]) return optimistic[wsId];
    return row.flag.status ?? "open";
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
        <p className="font-medium text-fg">Nothing flagged for Juliet.</p>
        <p className="mt-1">
          When a CSM raises the flag from a customer&apos;s expanded row on the{" "}
          <Link href="?tab=at-risk" className="text-accent underline">
            At-risk tab
          </Link>
          , the account shows up here for follow-up.
        </p>
      </div>
    );
  }

  // Sort: open first, then outreach_made, then resolved. Within each
  // status, newest raises first (so recent asks lead their group).
  // Ties on same-second raises fall back to workspace_id order for
  // deterministic rendering.
  const sorted = [...rows].sort((a, b) => {
    const sa = STATUS_ORDER[effectiveStatus(a)];
    const sb = STATUS_ORDER[effectiveStatus(b)];
    if (sa !== sb) return sa - sb;
    const cmp = b.flag.flagged_at.localeCompare(a.flag.flagged_at);
    if (cmp !== 0) return cmp;
    return (a.customer.workspace_id ?? "").localeCompare(
      b.customer.workspace_id ?? ""
    );
  });

  const openCount = sorted.filter((r) => effectiveStatus(r) === "open").length;

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted flex items-center gap-3 flex-wrap">
        <span>
          {openCount} open · {sorted.length - openCount} closed
          {sorted.length === 1 ? "" : ""}
        </span>
        {error ? (
          <span className="text-red-700 dark:text-red-300 text-xs">
            {error}
          </span>
        ) : null}
      </div>
      {sorted.map((row) => {
        const { customer, flag } = row;
        const status = effectiveStatus(row);
        const isClosed = status !== "open";
        return (
          <div
            key={customer.workspace_id ?? customer.stripe_customer_id ?? ""}
            className={`rounded-lg border shadow-card transition-opacity ${
              isClosed
                ? "border-border bg-surface opacity-70"
                : "border-purple-200 dark:border-purple-500/30 bg-surface"
            }`}
          >
            <div
              className={`border-b border-border p-4 ${
                isClosed
                  ? "bg-surface-2/40"
                  : "bg-purple-50/50 dark:bg-purple-500/5"
              }`}
            >
              <div className="flex items-baseline gap-3 flex-wrap">
                <h3 className="text-lg font-semibold text-fg">
                  {customer.company_name ?? customer.workspace_name ?? "—"}
                </h3>
                {customer.workspace_id ? (
                  <Link
                    href={`/account/${encodeURIComponent(customer.workspace_id)}`}
                    className="text-xs text-muted hover:text-fg underline decoration-dotted"
                  >
                    Open profile ↗
                  </Link>
                ) : null}
                <RiskLevelChip
                  level={customer.property_risk_level}
                  detail={customer.property_risk_level_detail}
                />
                <span className="text-xs text-muted">
                  {customer.stripe_plan ?? "—"} · ARR{" "}
                  {fmtCurrency(customer.arr)} · CSM{" "}
                  {customer.customer_success_manager?.replace(/_/g, " ") ??
                    "unassigned"}
                </span>
              </div>
              <div className="mt-2 flex items-start gap-2 flex-wrap text-xs">
                <span className="text-muted">
                  Raised {fmtDate(flag.flagged_at)}
                  {flag.flagged_by ? ` by ${flag.flagged_by}` : ""}
                </span>
                {flag.status_updated_at &&
                flag.status &&
                flag.status !== "open" ? (
                  <span className="text-muted">
                    · {STATUS_LABEL[flag.status]}{" "}
                    {fmtDate(flag.status_updated_at)}
                    {flag.status_updated_by
                      ? ` by ${flag.status_updated_by}`
                      : ""}
                  </span>
                ) : null}
                {flag.note ? (
                  <p className="basis-full text-sm text-fg mt-1 whitespace-pre-wrap break-words">
                    <span className="text-purple-800 dark:text-purple-300 font-medium">
                      Why:
                    </span>{" "}
                    {flag.note}
                  </p>
                ) : null}
                <div className="basis-full mt-2 flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wide text-subtle mr-1">
                    Status
                  </span>
                  {(["open", "outreach_made", "resolved"] as const).map(
                    (s) => {
                      const active = status === s;
                      const disabled =
                        pending ||
                        !customer.workspace_id ||
                        active;
                      return (
                        <button
                          key={s}
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            customer.workspace_id
                              ? setStatus(customer.workspace_id, s)
                              : undefined
                          }
                          className={`text-[11px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                            active
                              ? STATUS_STYLE[s]
                              : "bg-transparent border-border text-muted hover:text-fg hover:border-border-strong"
                          } ${
                            disabled && !active
                              ? "opacity-60 cursor-not-allowed"
                              : ""
                          }`}
                        >
                          {STATUS_LABEL[s]}
                        </button>
                      );
                    }
                  )}
                </div>
              </div>
            </div>
            <div className="p-4">
              <CustomerDetailPanel customer={customer} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
