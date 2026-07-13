"use client";

import type { Customer } from "@/lib/types";
import type { JulietFlag } from "@/lib/data/juliet-flags-store";
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

export function JulietFlagList({ rows }: { rows: FlaggedRow[] }) {
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

  // Newest raises first — Juliet's queue is chronological with the
  // most-recent escalation on top so she sees new asks before older
  // ones. Ties (same-second raises) fall back to workspace_id order
  // for stability.
  const sorted = [...rows].sort((a, b) => {
    const cmp = b.flag.flagged_at.localeCompare(a.flag.flagged_at);
    if (cmp !== 0) return cmp;
    return (a.customer.workspace_id ?? "").localeCompare(
      b.customer.workspace_id ?? ""
    );
  });

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">
        {sorted.length} account{sorted.length === 1 ? "" : "s"} flagged for
        Juliet outreach.
      </div>
      {sorted.map(({ customer, flag }) => (
        <div
          key={customer.workspace_id ?? customer.stripe_customer_id ?? ""}
          className="rounded-lg border border-purple-200 dark:border-purple-500/30 bg-surface shadow-card"
        >
          <div className="border-b border-border p-4 bg-purple-50/50 dark:bg-purple-500/5">
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
              {flag.note ? (
                <p className="basis-full text-sm text-fg mt-1 whitespace-pre-wrap break-words">
                  <span className="text-purple-800 dark:text-purple-300 font-medium">
                    Why:
                  </span>{" "}
                  {flag.note}
                </p>
              ) : null}
            </div>
          </div>
          <div className="p-4">
            <CustomerDetailPanel customer={customer} />
          </div>
        </div>
      ))}
    </div>
  );
}
