"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtDate, fmtNumber } from "@/components/format";
import { useZendeskSummary } from "@/lib/data/use-zendesk-overlay";
import { CustomerRequestsSection } from "@/components/am/customer-requests-section";
import {
  accountTone,
  decideBlocks,
  summarize,
  type BlockPlan,
  type BlockVerdict,
  type Tone,
} from "@/lib/workspace/blocks";

/**
 * The Workspace shell — one page, forever.
 *
 * Replaces the tab strip as the CSM front door. A thin account rail on
 * the left; on the right, only the blocks that have something to say
 * about the selected account today. Quiet accounts render two blocks.
 * Accounts in trouble fill the screen.
 *
 * The footer listing what ISN'T shown is load-bearing, not decoration.
 * A layout that changes per account is otherwise indistinguishable
 * from a broken one — you can't tell "no deliverability problem" from
 * "deliverability isn't on this screen". Naming every absence, with
 * its reason, is what makes the variation legible.
 *
 * Cross-account work hasn't gone anywhere: the old tab strip lives at
 * ?view=sweep and is one click away in the header.
 */

interface Props {
  customers: Customer[];
  requestsEnabled: boolean;
}

type RequestCounts = Record<
  string,
  { open: number; shipped: number; total: number }
>;

/** Map the fetch's three states onto what decideBlocks expects. */
function requestsFor(
  workspaceId: string | null | undefined,
  counts: RequestCounts | null,
  enabled: boolean
): { open: number; shipped: number; total: number } | "disabled" | "pending" {
  if (!enabled) return "disabled";
  if (counts === null) return "pending";
  return counts[workspaceId ?? ""] ?? { open: 0, shipped: 0, total: 0 };
}

const DOT: Record<Tone, string> = {
  urgent: "bg-red-500 dark:bg-red-400",
  watch: "bg-amber-500 dark:bg-amber-400",
  calm: "bg-emerald-500/60 dark:bg-emerald-400/60",
};

const EDGE: Record<Tone, string> = {
  urgent: "border-l-red-500 dark:border-l-red-400",
  watch: "border-l-amber-500 dark:border-l-amber-400",
  calm: "border-l-border",
};

export function WorkspaceShell({ customers, requestsEnabled }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    customers[0]?.workspace_id ?? null
  );
  const [filter, setFilter] = useState("");
  const [counts, setCounts] = useState<RequestCounts | null>(null);

  useEffect(() => {
    if (!requestsEnabled) return;
    let cancelled = false;
    fetch("/api/enterprise-requests/open-workspaces", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setCounts((body as { counts?: RequestCounts }).counts ?? {});
      })
      .catch(() => {
        if (!cancelled) setCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [requestsEnabled]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      [c.company_name, c.workspace_name, c.owner_email]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q))
    );
  }, [customers, filter]);

  const selected =
    visible.find((c) => c.workspace_id === selectedId) ?? visible[0] ?? null;

  return (
    <div className="flex gap-6 items-start">
      <AccountRail
        customers={visible}
        selectedId={selected?.workspace_id ?? null}
        onSelect={setSelectedId}
        filter={filter}
        onFilter={setFilter}
        counts={counts}
        requestsEnabled={requestsEnabled}
      />
      <div className="flex-1 min-w-0">
        {selected ? (
          <AccountView
            key={selected.workspace_id ?? selected.workspace_name}
            customer={selected}
            counts={counts}
            requestsEnabled={requestsEnabled}
          />
        ) : (
          <p className="text-sm text-muted italic">No accounts match.</p>
        )}
      </div>
    </div>
  );
}

function AccountRail({
  customers,
  selectedId,
  onSelect,
  filter,
  onFilter,
  counts,
  requestsEnabled,
}: {
  customers: Customer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  filter: string;
  onFilter: (v: string) => void;
  counts: RequestCounts | null;
  requestsEnabled: boolean;
}) {
  return (
    <aside className="w-56 shrink-0 hidden md:flex flex-col gap-2 sticky top-4">
      <label htmlFor="ws-filter" className="sr-only">
        Filter accounts
      </label>
      <input
        id="ws-filter"
        type="search"
        value={filter}
        onChange={(e) => onFilter(e.currentTarget.value)}
        placeholder="Filter…"
        className="w-full px-2.5 py-1.5 text-[13px] bg-surface border border-border rounded-lg text-fg focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <div className="flex flex-col gap-px max-h-[38rem] overflow-y-auto -mx-1 px-1">
        {customers.map((c) => (
          <RailRow
            key={c.workspace_id ?? c.workspace_name}
            customer={c}
            selected={c.workspace_id === selectedId}
            onSelect={onSelect}
            counts={counts}
            requestsEnabled={requestsEnabled}
          />
        ))}
      </div>
    </aside>
  );
}

function RailRow({
  customer: c,
  selected,
  onSelect,
  counts,
  requestsEnabled,
}: {
  customer: Customer;
  selected: boolean;
  onSelect: (id: string | null) => void;
  counts: RequestCounts | null;
  requestsEnabled: boolean;
}) {
  const zendesk = useZendeskSummary(c.workspace_id);
  const plan = decideBlocks({
    customer: c,
    zendesk: zendesk
      ? { total: zendesk.total_30d, high: zendesk.high_priority_30d }
      : null,
    requests: requestsFor(c.workspace_id, counts, requestsEnabled),
  });
  const tone = accountTone(plan);
  const liveCount = plan.live.length;

  return (
    <button
      type="button"
      onClick={() => onSelect(c.workspace_id ?? null)}
      aria-current={selected ? "true" : undefined}
      className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors ${
        selected ? "bg-surface" : "hover:bg-surface/60"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tone]}`}
        aria-hidden="true"
      />
      <span
        className={`flex-1 min-w-0 truncate text-[13px] ${
          selected ? "text-fg font-medium" : "text-fg/80"
        }`}
      >
        {c.company_name ?? c.workspace_name}
      </span>
      <span className="text-[10px] text-subtle tabular-nums shrink-0">
        {liveCount || "—"}
      </span>
    </button>
  );
}

function AccountView({
  customer: c,
  counts,
  requestsEnabled,
}: {
  customer: Customer;
  counts: RequestCounts | null;
  requestsEnabled: boolean;
}) {
  const zendesk = useZendeskSummary(c.workspace_id);
  const requests = requestsFor(c.workspace_id, counts, requestsEnabled);

  const plan: BlockPlan = useMemo(
    () =>
      decideBlocks({
        customer: c,
        zendesk: zendesk
          ? { total: zendesk.total_30d, high: zendesk.high_priority_30d }
          : null,
        requests,
      }),
    [c, zendesk, requests]
  );

  return (
    <div className="space-y-5">
      <header className="flex items-end gap-3 flex-wrap">
        <h1 className="font-display text-4xl font-medium text-fg leading-none">
          {c.company_name ?? c.workspace_name}
        </h1>
        <span className="text-sm text-muted pb-1">
          {fmtCurrency(c.arr)} · {c.stripe_plan ?? "—"} ·{" "}
          {c.company_engagement ?? "—"}
        </span>
        <span className="flex-1" />
        <span className="text-xs text-muted pb-1.5">{summarize(plan)}</span>
        {c.workspace_id ? (
          <Link
            href={`/account/${c.workspace_id}`}
            className="pb-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Full profile ↗
          </Link>
        ) : null}
      </header>

      {plan.live.length === 0 ? (
        <p className="text-sm text-muted italic">
          Nothing is true about this account today that needs your
          attention.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-6 gap-3">
          {plan.live.map((b) => (
            <Block key={b.id} block={b} customer={c} />
          ))}
        </div>
      )}

      {typeof requests === "object" && requests.total > 0 ? (
        <CustomerRequestsSection customer={c} enabled={requestsEnabled} />
      ) : null}

      <AbsenceNote plan={plan} />
    </div>
  );
}

function Block({
  block: b,
  customer: c,
}: {
  block: BlockVerdict;
  customer: Customer;
}) {
  return (
    <section
      className={`lg:col-span-${b.span} rounded-xl border border-border border-l-[3px] ${EDGE[b.tone]} bg-surface p-4`}
      style={{ gridColumn: `span ${b.span} / span ${b.span}` }}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-fg">{b.label}</h2>
        <span
          className={`text-xs tabular-nums ${
            b.tone === "urgent"
              ? "text-red-700 dark:text-red-300"
              : b.tone === "watch"
                ? "text-amber-700 dark:text-amber-300"
                : "text-muted"
          }`}
        >
          {b.fact}
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-fg">{b.detail}</p>
      <BlockExtra block={b} customer={c} />
    </section>
  );
}

/** The one or two concrete details a block earns beyond its sentence.
 *  Deliberately thin — the full profile is a click away and this is
 *  meant to be read, not mined. */
function BlockExtra({
  block: b,
  customer: c,
}: {
  block: BlockVerdict;
  customer: Customer;
}) {
  if (b.id === "renewal" && c.renewal_date) {
    return (
      <p className="mt-2 text-[11px] text-muted tabular-nums">
        {fmtDate(c.renewal_date)}
        {c.next_invoice ? ` · next invoice ${fmtDate(c.next_invoice)}` : ""}
      </p>
    );
  }
  if (b.id === "utilization") {
    return (
      <p className="mt-2 text-[11px] text-muted tabular-nums">
        {fmtNumber(c.active_subs)} of {fmtNumber(c.max_subscriptions)}
      </p>
    );
  }
  if (b.id === "sends" && c.last_send) {
    return (
      <p className="mt-2 text-[11px] text-muted tabular-nums">
        last send {fmtDate(c.last_send)}
      </p>
    );
  }
  if (b.id === "people") {
    const contacts = (c.hubspot_contacts ?? []).slice(0, 3);
    return (
      <ul className="mt-2 space-y-0.5">
        {contacts.map((p, i) => (
          <li key={`${p.email ?? i}`} className="text-[11px] text-muted truncate">
            {p.name ?? p.email}
            {p.job_title ? ` · ${p.job_title}` : ""}
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

/**
 * What isn't on screen, and why.
 *
 * The counterweight to a variable layout. Without it you can't tell a
 * quiet account from a broken page, and people stop trusting the
 * absence of a block to mean anything.
 */
function AbsenceNote({ plan }: { plan: BlockPlan }) {
  if (plan.absent.length === 0) return null;
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-3">
      <p className="text-[11px] leading-relaxed text-muted">
        <span className="font-medium text-subtle">Not shown, because: </span>
        {plan.absent.map((a, i) => (
          <span key={a.id}>
            {i > 0 ? " · " : ""}
            <span className="text-fg/70">{a.label}</span>
            <span className="text-subtle"> &mdash; </span>
            {a.why}
          </span>
        ))}
      </p>
    </div>
  );
}
