import Link from "next/link";
import {
  filterCustomers,
  getDataSource,
  isEnterprise,
  loadCustomers,
} from "@/lib/data/load-customers";
import { runAtRiskCheck } from "@/lib/engines/at-risk";
import { fmtCompactCurrency } from "@/components/format";
import type { Customer, Segment } from "@/lib/types";

export const dynamic = "force-dynamic";

interface SP {
  csm?: string;
  segment?: Segment;
}

function utilFor(c: Customer): number | null {
  if (c.percent_of_max_subs != null) {
    return c.percent_of_max_subs > 1
      ? c.percent_of_max_subs
      : c.percent_of_max_subs * 100;
  }
  if (c.active_subs != null && c.max_subscriptions) {
    return (c.active_subs / c.max_subscriptions) * 100;
  }
  return null;
}

export default async function MissionControl({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const csm = sp.csm ?? null;
  const segment: Segment = (sp.segment as Segment) ?? "all";
  const source = getDataSource();

  let error: string | null = null;
  let book: Customer[] = [];
  let entCount = 0;
  let nonEntCount = 0;
  let atRiskCount = 0;
  let approachingEntCount = 0;

  try {
    const all = await loadCustomers();
    book = filterCustomers(all, { csm, segment });
    entCount = book.filter(isEnterprise).length;
    nonEntCount = book.length - entCount;
    approachingEntCount = book
      .filter((c) => !isEnterprise(c))
      .filter((c) => {
        const subs = c.active_subs ?? 0;
        return subs >= 80_000 && subs < 100_000;
      }).length;

    const at = await runAtRiskCheck({
      customers: book.filter(isEnterprise),
      csmName: null,
    });
    atRiskCount = at.accounts.length;
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  const totalArr = book.reduce((s, c) => s + c.arr, 0);
  const renewals30 = book.filter((c) => {
    if (!c.renewal_date) return false;
    const days = Math.ceil(
      (new Date(c.renewal_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    return days >= 0 && days <= 30;
  }).length;
  const dormant = book.filter((c) => {
    if (!c.last_send) return true;
    const days = Math.ceil(
      (Date.now() - new Date(c.last_send).getTime()) / (1000 * 60 * 60 * 24)
    );
    return days >= 10;
  }).length;
  const utilOver90 = book.filter((c) => {
    const u = utilFor(c);
    return u != null && u > 90;
  }).length;

  return (
    <>
      <div className="mb-10">
        <h1 className="text-[40px] leading-[1.1] font-semibold text-fg tracking-tight">
          Portfolio overview
        </h1>
        <p className="text-[15px] text-muted mt-3">
          Data from{" "}
          <code className="bg-surface-2 px-1.5 py-0.5 rounded text-fg font-mono text-[13px]">
            {source}
          </code>
          {csm ? (
            <> · CSM <strong className="text-fg">{csm.replace(/_/g, " ")}</strong></>
          ) : null}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4 mb-6">
          <p className="text-red-800 dark:text-red-300 font-medium">Failed to load data</p>
          <p className="text-red-600 text-sm mt-1">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Accounts" value={String(book.length)} />
        <Stat label="Total ARR" value={fmtCompactCurrency(totalArr)} />
        <Stat label="Enterprise" value={String(entCount)} />
        <Stat label="Growth" value={String(nonEntCount)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Tile
          href="/csm?tab=at-risk"
          title="At-risk accounts"
          metric={String(atRiskCount)}
          detail="Enterprise accounts with one or more risk flags (A/B/C/G)."
          tone={atRiskCount > 0 ? "warn" : "ok"}
        />
        <Tile
          href="/csm?tab=renewals"
          title="Renewals in 30 days"
          metric={String(renewals30)}
          detail="Across the current segment / CSM filter."
          tone={renewals30 > 0 ? "warn" : "ok"}
        />
        <Tile
          href="/csm"
          title="Subs > 90% of tier"
          metric={String(utilOver90)}
          detail="Enterprise accounts approaching their subscriber cap."
          tone={utilOver90 > 0 ? "warn" : "ok"}
        />
        <Tile
          href="/csm"
          title="Dormant (10d+ no send)"
          metric={String(dormant)}
          detail="Accounts that haven't sent a newsletter in 10+ days."
          tone={dormant > 0 ? "warn" : "ok"}
        />
        <Tile
          href="/am"
          title="Approaching Enterprise (Growth)"
          metric={String(approachingEntCount)}
          detail="Non-Enterprise accounts at 80K–100K subs (the Enterprise trigger window)."
          tone={approachingEntCount > 0 ? "info" : "ok"}
        />
        <Tile
          href="/csm?tab=deliverability"
          title="Deliverability"
          metric="→"
          detail="Run yesterday's red-flag check against ClickHouse."
          tone="info"
        />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-card px-5 py-5">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="text-[28px] leading-tight font-semibold mt-1 text-fg tracking-tight">
        {value}
      </p>
    </div>
  );
}

function Tile({
  href,
  title,
  metric,
  detail,
}: {
  href: string;
  title: string;
  metric: string;
  detail: string;
  tone?: "ok" | "warn" | "info";
}) {
  return (
    <Link
      href={href}
      className="group block rounded-xl border border-border shadow-card bg-surface p-6 hover:shadow-card-lg hover:border-border-strong transition-all"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-[15px] font-medium text-fg tracking-tight">
          {title}
        </h3>
        <span className="text-4xl font-semibold text-fg tracking-tight">
          {metric}
        </span>
      </div>
      <p className="text-[13.5px] text-muted mt-2 leading-relaxed">{detail}</p>
    </Link>
  );
}
