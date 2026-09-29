"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Customer } from "@/lib/types";
import { lastContacted, subUtilFraction } from "@/lib/customer-helpers";
import { fmtCurrency, fmtDate, fmtNumber, fmtPct } from "@/components/format";
import { RiskLevelChip } from "@/components/risk-level-chip";
import { CustomerRequestsSection } from "@/components/am/customer-requests-section";
import {
  compareRows,
  matchesSearch,
  matchesView,
  rowSignal,
  VIEWS,
  type OpenRequestCounts,
  type RowSignal,
  type ViewId,
} from "@/lib/accounts-view/views";

/**
 * Three-pane Accounts surface — saved views, one list, one preview.
 *
 * The premise: the /csm tabs are mostly the same book filtered
 * differently, but each is its own page, so moving between them loses
 * your place and makes you re-find the account you were looking at.
 * Here they're filters over one list and the account stays selected.
 *
 * Everything filters client-side. The whole book is a few hundred rows
 * and it's already in memory for the table, so switching views is
 * instant — which is the entire feel this is testing. A round-trip per
 * view would make it just the tabs again with different chrome.
 */

interface Props {
  customers: Customer[];
  /** Whether the viewer can see the Enterprise Request Loop. Drives
   *  the "Open requests" view and the Requests block in the preview;
   *  when off, both are hidden rather than rendered empty. */
  requestsEnabled: boolean;
}

const RAIL: Record<RowSignal["severity"], string> = {
  urgent: "bg-red-500 dark:bg-red-400",
  watch: "bg-amber-500 dark:bg-amber-400",
  calm: "bg-emerald-500/70 dark:bg-emerald-400/70",
};

export function AccountsWorkspace({ customers, requestsEnabled }: Props) {
  const [view, setView] = useState<ViewId>("book");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counts, setCounts] = useState<OpenRequestCounts>({});

  // Open-request counts per workspace. One fetch, reused by both the
  // "Open requests" view and every row's signal line.
  useEffect(() => {
    if (!requestsEnabled) return;
    let cancelled = false;
    fetch("/api/enterprise-requests/open-workspaces", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setCounts((body as { counts?: OpenRequestCounts }).counts ?? {});
      })
      .catch(() => {
        // Non-fatal: rows just lose their request counts.
      });
    return () => {
      cancelled = true;
    };
  }, [requestsEnabled]);

  const rows = useMemo(() => {
    return customers
      .filter((c) => matchesSearch(c, search))
      .filter((c) => matchesView(c, view, counts))
      .map((c) => ({ customer: c, signal: rowSignal(c, counts) }))
      .sort(compareRows);
  }, [customers, search, view, counts]);

  // Counts for the rail. Computed against search so the numbers agree
  // with what clicking would actually show.
  const viewCounts = useMemo(() => {
    const searched = customers.filter((c) => matchesSearch(c, search));
    const out: Partial<Record<ViewId, number>> = {};
    for (const v of VIEWS) {
      out[v.id] = searched.filter((c) => matchesView(c, v.id, counts)).length;
    }
    return out;
  }, [customers, search, counts]);

  // Keep a selection that's still in the list; otherwise take the top
  // row, so the preview pane is never blank next to a populated list.
  const selected = useMemo(() => {
    const inList = rows.find((r) => r.customer.workspace_id === selectedId);
    return inList ?? rows[0] ?? null;
  }, [rows, selectedId]);

  const activeView = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  return (
    <div className="flex gap-4 items-start">
      {/* ── Saved views ─────────────────────────────────────────── */}
      <aside className="w-48 shrink-0 hidden md:block">
        <div className="text-[10px] font-semibold tracking-wide text-subtle mb-2">
          VIEWS
        </div>
        <div className="flex flex-col gap-0.5">
          {VIEWS.filter((v) => v.id !== "requests" || requestsEnabled).map(
            (v) => {
              const on = v.id === view;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  aria-current={on ? "true" : undefined}
                  className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left text-sm transition-colors ${
                    on
                      ? "bg-surface-2 text-fg font-medium"
                      : "text-fg hover:bg-canvas"
                  }`}
                >
                  <span className="flex-1 truncate">{v.label}</span>
                  <span className="text-xs text-muted tabular-nums">
                    {viewCounts[v.id] ?? 0}
                  </span>
                </button>
              );
            }
          )}
        </div>
        <p className="mt-4 pt-3 border-t border-border text-[11px] leading-snug text-muted">
          Each of these is a tab today. Here they filter one list, so
          switching keeps your place and your selected account.
        </p>
      </aside>

      {/* ── The list ────────────────────────────────────────────── */}
      <section className="w-full md:w-[27rem] shrink-0 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <h2 className="text-lg font-semibold text-fg">{activeView.label}</h2>
          <span className="text-xs text-muted tabular-nums">
            {rows.length} account{rows.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="text-[11px] text-muted mb-2">{activeView.blurb}</p>

        <label htmlFor="accounts-search" className="sr-only">
          Search accounts
        </label>
        <input
          id="accounts-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search accounts, contacts…"
          className="w-full mb-2 px-3 py-1.5 text-sm bg-surface border border-border-strong rounded-md text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {rows.length === 0 ? (
          <p className="text-sm text-muted italic px-1 py-3">
            No accounts in this view.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 max-h-[34rem] overflow-y-auto pr-1">
            {rows.map(({ customer, signal }) => {
              const on = customer.workspace_id === selected?.customer.workspace_id;
              return (
                <li key={customer.workspace_id ?? customer.workspace_name}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(customer.workspace_id ?? null)}
                    aria-current={on ? "true" : undefined}
                    className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg border text-left transition-colors ${
                      on
                        ? "bg-surface border-border-strong"
                        : "bg-transparent border-transparent hover:bg-surface/60"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-8 rounded-sm shrink-0 ${RAIL[signal.severity]}`}
                      aria-hidden="true"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-fg truncate">
                        {customer.company_name ?? customer.workspace_name}
                      </span>
                      <span className="block text-[11px] text-muted truncate">
                        {signal.line}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-xs text-fg tabular-nums">
                        {fmtCurrency(customer.arr)}
                      </span>
                      <span className="block text-[10px] text-muted">
                        {customer.renewal_date
                          ? fmtDate(customer.renewal_date)
                          : "—"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Preview ─────────────────────────────────────────────── */}
      <section className="flex-1 min-w-0 hidden lg:block">
        {selected ? (
          <AccountPreview
            customer={selected.customer}
            signal={selected.signal}
            requestsEnabled={requestsEnabled}
          />
        ) : (
          <p className="text-sm text-muted italic">
            Select an account to preview it.
          </p>
        )}
      </section>
    </div>
  );
}

function AccountPreview({
  customer: c,
  signal,
  requestsEnabled,
}: {
  customer: Customer;
  signal: RowSignal;
  requestsEnabled: boolean;
}) {
  const util = subUtilFraction(c);
  const contact = lastContacted(c);

  return (
    <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-fg truncate">
            {c.company_name ?? c.workspace_name}
          </h3>
          <p className="text-[11px] text-muted mt-0.5">
            {c.stripe_plan ?? "—"} · {c.company_engagement ?? "—"} ·{" "}
            {c.renewal_date
              ? `renews ${fmtDate(c.renewal_date)}`
              : "no renewal date"}
          </p>
        </div>
        {c.workspace_id ? (
          <Link
            href={`/account/${c.workspace_id}`}
            className="shrink-0 px-2.5 py-1 text-xs rounded-md border border-border-strong text-fg hover:bg-canvas"
          >
            Full profile
          </Link>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="ARR" value={fmtCurrency(c.arr)} />
        <Stat
          label="Utilization"
          value={util != null ? fmtPct(util * 100) : "—"}
        />
        <Stat
          label="Last contact"
          value={contact.date ? fmtDate(contact.date) : "—"}
          hint={contact.date ? `via ${contact.source}` : undefined}
        />
      </div>

      {/* The same sentence the row showed, restated with its basis —
          so clicking a row never leaves you wondering which signal
          put it where it is. */}
      <div className="rounded-lg border border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${RAIL[signal.severity]}`}
            aria-hidden="true"
          />
          <span className="text-xs font-medium text-fg">Why it&rsquo;s here</span>
        </div>
        <p className="mt-1 text-xs text-fg leading-snug">{signal.line}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <RiskLevelChip
            level={c.property_risk_level}
            detail={c.property_risk_level_detail}
          />
          {c.active_subs != null ? (
            <span className="text-[10px] text-muted tabular-nums">
              {fmtNumber(c.active_subs)} subs
            </span>
          ) : null}
        </div>
      </div>

      {requestsEnabled ? (
        <CustomerRequestsSection customer={c} enabled={requestsEnabled} />
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-canvas px-2.5 py-2" title={hint}>
      <div className="text-[9px] uppercase tracking-wide text-subtle">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-fg tabular-nums">
        {value}
      </div>
    </div>
  );
}
