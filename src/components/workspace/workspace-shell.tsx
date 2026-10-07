"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtDate, fmtNumber } from "@/components/format";
import { useZendeskSummary } from "@/lib/data/use-zendesk-overlay";
import { CustomerRequestsSection } from "@/components/am/customer-requests-section";
import {
  hubspotCompanyUrl,
  masqueradeUrl,
  stripeCustomerUrl,
} from "@/lib/links";
import {
  accountTone,
  decideBlocks,
  type BlockPlan,
  type BlockVerdict,
  type Tone,
} from "@/lib/workspace/blocks";

/**
 * The Workspace shell — one page, forever.
 *
 * Layout note, because the first build got this wrong: the blocks are
 * full-width BANDS in a single column, not cards in a grid. A grid
 * sized for the busy case leaves half a row empty on the quiet one,
 * and most accounts are quiet — so the common view was a void with two
 * cards floating in it. Bands fill the width at any count, read
 * top-to-bottom in severity order, and a one-block account looks
 * deliberate rather than broken.
 *
 * Cross-account work lives at ?view=sweep — the old tab strip, intact.
 */

interface Props {
  customers: Customer[];
  requestsEnabled: boolean;
  /** Whose book this is, already humanised. Shown on the rail so the
   *  count sits beside the list it counts. */
  csmLabel?: string | null;
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
  calm: "bg-emerald-500/50 dark:bg-emerald-400/50",
};

const BAR: Record<Tone, string> = {
  urgent: "bg-red-500 dark:bg-red-400",
  watch: "bg-amber-500 dark:bg-amber-400",
  calm: "bg-border",
};

const FACT: Record<Tone, string> = {
  urgent: "text-red-700 dark:text-red-300",
  watch: "text-amber-700 dark:text-amber-300",
  calm: "text-muted",
};

export function WorkspaceShell({
  customers,
  requestsEnabled,
  csmLabel,
}: Props) {
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
    <div className="flex gap-8 items-start">
      <aside className="w-52 shrink-0 hidden md:flex flex-col gap-2 sticky top-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold tracking-wide text-subtle">
            {visible.length === customers.length
              ? `${customers.length} ACCOUNTS`
              : `${visible.length} OF ${customers.length}`}
          </span>
          {csmLabel ? (
            <span className="text-[10px] text-subtle truncate">
              {csmLabel}
            </span>
          ) : null}
        </div>
        <label htmlFor="ws-filter" className="sr-only">
          Filter accounts
        </label>
        <input
          id="ws-filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter accounts…"
          className="w-full px-1 py-1.5 text-[13px] bg-transparent border-0 border-b border-border text-fg placeholder:text-subtle focus:outline-none focus:border-fg"
        />
        <div className="flex flex-col max-h-[40rem] overflow-y-auto">
          {visible.map((c) => (
            <RailRow
              key={c.workspace_id ?? c.workspace_name}
              customer={c}
              selected={c.workspace_id === selected?.workspace_id}
              onSelect={setSelectedId}
              counts={counts}
              requestsEnabled={requestsEnabled}
            />
          ))}
        </div>
      </aside>

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

  return (
    <button
      type="button"
      onClick={() => onSelect(c.workspace_id ?? null)}
      aria-current={selected ? "true" : undefined}
      className={`group flex items-center gap-2.5 w-full py-[5px] pl-2.5 text-left border-l-2 transition-colors ${
        selected
          ? "border-l-fg"
          : "border-l-transparent hover:border-l-border-strong"
      }`}
    >
      <span
        className={`w-[5px] h-[5px] rounded-full shrink-0 ${DOT[tone]}`}
        aria-hidden="true"
      />
      <span
        className={`flex-1 min-w-0 truncate text-[12.5px] leading-tight ${
          selected ? "text-fg font-medium" : "text-muted group-hover:text-fg"
        }`}
      >
        {c.company_name ?? c.workspace_name}
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

  const urgent = plan.live.filter((b) => b.tone === "urgent").length;

  return (
    <div className="max-w-3xl">
      {/* ── Masthead ─────────────────────────────────────────────── */}
      <header className="pb-3 border-b-2 border-fg">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-[2.5rem] leading-[1.05] font-medium text-fg min-w-0 break-words">
            {c.company_name ?? c.workspace_name}
          </h1>
          <span className="flex-1" />
          <JumpLinks customer={c} />
        </div>
        <div className="mt-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted">
          <span className="tabular-nums text-fg font-medium">
            {fmtCurrency(c.arr)}
          </span>
          <span>{c.stripe_plan ?? "—"}</span>
          <span>{c.company_engagement ?? "—"}</span>
          <span className="tabular-nums">
            {fmtNumber(c.active_subs)} subscribers
          </span>
          <span className="flex-1" />
          <span className={urgent > 0 ? FACT.urgent : "text-muted"}>
            {urgent > 0
              ? `${urgent} need${urgent === 1 ? "s" : ""} attention`
              : plan.live.length > 0
                ? `${plan.live.length} worth knowing`
                : "nothing today"}
          </span>
        </div>
      </header>

      {/* ── Bands ────────────────────────────────────────────────── */}
      {plan.live.length === 0 ? (
        <p className="py-7 text-[15px] leading-relaxed text-muted max-w-prose">
          Nothing about this account needs you today. Everything we check
          is listed below, with where it stands.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {plan.live.map((b) => (
            <Band key={b.id} block={b} customer={c} />
          ))}
        </div>
      )}

      {typeof requests === "object" && requests.total > 0 ? (
        <div className="mt-5">
          <CustomerRequestsSection customer={c} enabled={requestsEnabled} />
        </div>
      ) : null}

      <AbsenceNote plan={plan} />
    </div>
  );
}

/**
 * The jump-offs: Masquerade, Stripe, HubSpot, full profile.
 *
 * These were on every row of the customer table via RowActions, and
 * Stripe was also on the detail panel. Replacing /csm with the
 * Workspace moved both behind ?view=sweep, which quietly took a
 * one-click jump to HubSpot or Stripe and made it four — a real daily
 * cost that had nothing to do with the redesign's argument.
 *
 * A link only renders when the id behind it exists, so an account with
 * no HubSpot match shows three, not a dead fourth.
 */
function JumpLinks({ customer: c }: { customer: Customer }) {
  const masq = masqueradeUrl(c.owner_email);
  const stripe = stripeCustomerUrl(c.stripe_customer_id);
  const hubspot = hubspotCompanyUrl(c.hubspot_company_id);
  const cls =
    "shrink-0 text-xs text-muted hover:text-fg underline decoration-dotted underline-offset-4";

  return (
    <div className="flex items-center gap-3 shrink-0">
      {masq ? (
        <a
          href={masq}
          target="_blank"
          rel="noopener noreferrer"
          className={cls}
          title="Masquerade into the workspace"
        >
          Masq
        </a>
      ) : null}
      {stripe ? (
        <a
          href={stripe}
          target="_blank"
          rel="noopener noreferrer"
          className={cls}
          title="Open in the Stripe dashboard"
        >
          Stripe
        </a>
      ) : null}
      {hubspot ? (
        <a
          href={hubspot}
          target="_blank"
          rel="noopener noreferrer"
          className={cls}
          title="Open the company in HubSpot"
        >
          HubSpot
        </a>
      ) : null}
      {c.workspace_id ? (
        <Link href={`/account/${c.workspace_id}`} className={cls}>
          Full profile
        </Link>
      ) : null}
    </div>
  );
}

/**
 * One block, as a full-width band.
 *
 * Label and headline fact sit in a fixed left column so they line up
 * down the page and the eye can run the left edge; the sentence takes
 * the rest of the width. A 2px tone bar is the only colour — enough to
 * find the urgent ones without the page becoming a traffic light.
 */
function Band({
  block: b,
  customer: c,
}: {
  block: BlockVerdict;
  customer: Customer;
}) {
  return (
    <section className="flex gap-5 py-4">
      <span
        className={`w-[2px] shrink-0 rounded-full ${BAR[b.tone]}`}
        aria-hidden="true"
      />
      <div className="w-32 shrink-0">
        <h2 className="text-[13px] font-semibold text-fg leading-snug">
          {b.label}
        </h2>
        <p className={`mt-0.5 text-[13px] tabular-nums ${FACT[b.tone]}`}>
          {b.fact}
        </p>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[15px] leading-relaxed text-fg">{b.detail}</p>
        <BandExtra block={b} customer={c} />
      </div>
    </section>
  );
}

function BandExtra({
  block: b,
  customer: c,
}: {
  block: BlockVerdict;
  customer: Customer;
}) {
  const cls = "mt-1.5 text-xs text-muted tabular-nums";
  if (b.id === "renewal" && c.renewal_date) {
    return (
      <p className={cls}>
        {fmtDate(c.renewal_date)}
        {c.next_invoice ? ` · next invoice ${fmtDate(c.next_invoice)}` : ""}
      </p>
    );
  }
  if (b.id === "utilization") {
    return (
      <p className={cls}>
        {fmtNumber(c.active_subs)} of {fmtNumber(c.max_subscriptions)}
      </p>
    );
  }
  if (b.id === "sends" && c.last_send) {
    return <p className={cls}>last send {fmtDate(c.last_send)}</p>;
  }
  if (b.id === "people") {
    const contacts = (c.hubspot_contacts ?? []).slice(0, 4);
    return (
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
        {contacts.map((p, i) => (
          <li key={p.email ?? i} className="text-xs text-muted">
            <span className="text-fg/80">{p.name ?? p.email}</span>
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
 * A two-column definition list rather than the run-on grey paragraph
 * this started as — that version was the widest, greyest thing on the
 * page, which handed the least important content the most weight.
 */
function AbsenceNote({ plan }: { plan: BlockPlan }) {
  if (plan.absent.length === 0) return null;
  return (
    <div className="mt-6 pt-4 border-t border-border">
      <h2 className="text-[10px] font-semibold tracking-wide text-subtle">
        CHECKED, NOT SHOWN
      </h2>
      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
        {plan.absent.map((a) => (
          <div key={a.id} className="flex gap-2 text-xs">
            <dt className="w-24 shrink-0 text-fg/60">{a.label}</dt>
            <dd className="flex-1 min-w-0 text-muted">{a.why}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
