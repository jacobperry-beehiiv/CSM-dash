"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtDate } from "./format";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import {
  FeatureUtilizationFilter,
  type WorkspaceFeatureMatcher,
} from "./feature-utilization-filter";
import { RiskLevelChip } from "./risk-level-chip";
import { RowActions } from "./row-actions";
import { FilterBar, SearchInput, SelectFilter } from "./filters";
import { CsmSelector } from "./csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import {
  DEFAULT_LIFECYCLE_STAGES,
  resolveLifecycleStages,
  type SettingsShape,
} from "@/lib/data/settings-types";
import type { OverrideMap } from "@/lib/data/customer-overrides";
import type {
  ReviewState,
  ReviewStatesMap,
} from "@/lib/data/review-states-types";
import { needsReview } from "@/lib/data/review-states-types";
import { BulkEmailLauncher } from "./am/bulk-email-launcher";
import { CopyPubIdsButton } from "./am/copy-pub-ids-button";
import { ReviewStateCell } from "./am/review-state-cell";
import { BulkReviewStateActions } from "./am/bulk-review-state-actions";
import { PingSelectedButton } from "./am/ping-selected-button";
import {
  billingPeriodSuffix,
  bucketLabel,
  cadenceRowLabel,
  intervalBucket,
} from "@/lib/customer-helpers";
import { nextRenewalDate, priorRenewalDate } from "./renewal-panel";

/**
 * Renewal Calendar — calendar-anchored sibling of RenewalPanel.
 *
 * RenewalPanel is forward-looking: "what's coming up in the next 120
 * days, bucketed by urgency." This panel answers a different question:
 * "show me everything that renews in a given month." Same data source
 * (the customer book + `nextRenewalDate`), same row chrome (review
 * state, lifecycle, bulk select, expand-for-detail). Different filter
 * axis — picks a calendar month instead of a relative time window.
 *
 * Data caveat: once a customer renews, Stripe rolls their renewal_date
 * forward (typically by 12 months), so the customer drops out of the
 * prior-month view. We surface that inline at the top of the panel so
 * an empty May 2026 doesn't read as "no May renewals happened." A
 * KV-backed historical renewal log would lift the caveat — flagged as
 * a follow-up; not in v1.
 */

interface Props {
  customers: Customer[];
  csms: string[];
}

/** YYYY-MM key for the local-time month of `d`. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "June 2026" for `"2026-06"`. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/** Today's YYYY-MM. Re-evaluated on mount only — the panel doesn't
 *  re-render mid-session as the clock ticks past midnight. */
function thisMonthKey(): string {
  return monthKey(new Date());
}

/** Previous calendar month from `ym` (e.g. 2026-06 → 2026-05). */
function previousMonthKey(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const prev = new Date(y, m - 2, 1);
  return monthKey(prev);
}

/** True when `d` falls inside the calendar month `ym`. */
function inMonth(d: Date | null, ym: string): boolean {
  if (!d) return false;
  return monthKey(d) === ym;
}

export function RenewalCalendarPanel({ customers, csms }: Props) {
  const [outreachFor, setOutreachFor] = useState<Customer | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Feature-usage chip filter — matches the shared AM / CSM pattern.
  const [featureMatcher, setFeatureMatcher] =
    useState<WorkspaceFeatureMatcher | null>(null);
  const onFeatureFilterChange = useCallback(
    (matcher: WorkspaceFeatureMatcher | null) => {
      setFeatureMatcher(() => matcher);
    },
    []
  );
  const featureWorkspaceIds = useMemo(
    () =>
      customers
        .map((c) => c.workspace_id)
        .filter((id): id is string => Boolean(id)),
    [customers]
  );
  // Cadence filter — same dropdown as RenewalPanel, defaults to
  // annual (the dominant renewal motion). "" → all cadences.
  const [intervalFilter, setIntervalFilter] = useState<string>("annual");
  // Calendar-month filter. Defaults to current month so opening the
  // tab today shows whoever's renewing this month.
  const [month, setMonth] = useState<string>(thisMonthKey());
  const [search, setSearch] = useUrlSearch("q");
  const { ws2pubs } = usePublicationsIndex();
  const [overrides, setOverrides] = useState<OverrideMap>({});
  const [lifecycleOptions, setLifecycleOptions] = useState<string[]>(
    DEFAULT_LIFECYCLE_STAGES
  );
  const [reviewStates, setReviewStates] = useState<ReviewStatesMap>({});
  const [needsReviewFilter, setNeedsReviewFilter] = useUrlSearch("needs_review");
  const [lifecycleFilter, setLifecycleFilter] = useUrlSearch("lifecycle");

  useEffect(() => {
    fetch("/api/customer-overrides")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setOverrides(j as OverrideMap))
      .catch(() => {});
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const s = (j as SettingsShape | null)?.am?.lifecycle_stages;
        setLifecycleOptions(resolveLifecycleStages(s));
      })
      .catch(() => {});
    fetch("/api/review-states")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setReviewStates(j as ReviewStatesMap))
      .catch(() => {});
  }, []);

  // Suppress the lint warning — the setter exists for completeness
  // (URL-state hook returns one) but no inline UI clears it; the
  // ?needs_review=1 deep-link from digest emails is the only path
  // that sets it. Same shape as RenewalPanel.
  void setNeedsReviewFilter;

  const onReviewChange = useCallback(
    (workspaceId: string, next: ReviewState | null) => {
      setReviewStates((prev) => {
        const map = { ...prev };
        const current = { ...(map[workspaceId] ?? {}) };
        if (next === null) {
          delete current.renewals;
        } else {
          current.renewals = {
            state: next,
            set_at: new Date().toISOString(),
            set_by: null,
          };
        }
        if (Object.keys(current).length === 0) {
          delete map[workspaceId];
        } else {
          map[workspaceId] = current;
        }
        return map;
      });
    },
    []
  );

  const setLifecycle = useCallback(
    async (workspaceId: string, stage: string) => {
      setOverrides((prev) => {
        const next = { ...prev };
        const current = { ...(next[workspaceId] ?? {}) };
        if (!stage) {
          delete current.lifecycle_stage;
          delete current.lifecycle_stage_updated_at;
          delete current.lifecycle_stage_updated_by;
        } else {
          current.lifecycle_stage = stage;
        }
        if (Object.keys(current).length === 0) {
          delete next[workspaceId];
        } else {
          next[workspaceId] = current;
        }
        return next;
      });
      try {
        const r = await fetch("/api/customer-overrides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: workspaceId,
            lifecycle_stage: stage || null,
          }),
        });
        if (r.ok) {
          const map = (await r.json()) as OverrideMap;
          setOverrides(map);
        }
      } catch {
        /* non-fatal */
      }
    },
    []
  );

  // Reset row-level state when the underlying customer set changes
  // (CSM switch). Same shape as RenewalPanel.
  const customerSignature = useMemo(
    () => customers.map((c) => c.workspace_id ?? "").sort().join("|"),
    [customers]
  );
  useEffect(() => {
    setExpanded(new Set());
    setSelected(new Set());
    setIntervalFilter("annual");
    setSearch("");
    // Don't reset `month` on customer switch — a CSM switching scope
    // probably still wants to see "this June" not get bounced back
    // to default.
  }, [customerSignature, setSearch]);

  function rowKey(c: Customer, idx: number): string {
    return c.workspace_id ?? c.stripe_customer_id ?? `row-${idx}`;
  }

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Sparse list of YYYY-MM keys for every month that has at least one
  // renewal (upcoming OR inferred-past) in the book. Plus the current
  // month, even if empty — so "This month" always lands on a real
  // option in the dropdown.
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    set.add(thisMonthKey());
    for (const c of customers) {
      for (const iso of [nextRenewalDate(c), priorRenewalDate(c)]) {
        if (!iso) continue;
        const d = new Date(iso);
        if (isNaN(d.getTime())) continue;
        set.add(monthKey(d));
      }
    }
    const sorted = [...set].sort();
    return sorted.map((ym) => ({ value: ym, label: monthLabel(ym) }));
  }, [customers]);

  const intervalOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of customers) {
      const bucket = intervalBucket(c);
      if (!bucket || bucket === "monthly") continue;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, count]) => ({
        value: bucket,
        label: bucketLabel(bucket),
        count,
      }));
  }, [customers]);

  const nonMonthlyCount = useMemo(
    () =>
      customers.filter((c) => {
        const bucket = intervalBucket(c);
        return bucket && bucket !== "monthly";
      }).length,
    [customers]
  );

  function lifecycleStage(c: Customer): string {
    if (!c.workspace_id) return "";
    return overrides[c.workspace_id]?.lifecycle_stage?.trim() ?? "";
  }

  const lifecycleFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let unset = 0;
    for (const c of customers) {
      if (intervalBucket(c) === "monthly") continue;
      const stage = lifecycleStage(c);
      if (!stage) {
        unset++;
        continue;
      }
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    const named = lifecycleOptions.map((stage) => ({
      value: stage,
      label: stage,
      count: counts.get(stage) ?? 0,
    }));
    const legacy = [...counts.entries()]
      .filter(([stage]) => !lifecycleOptions.includes(stage))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stage, count]) => ({
        value: stage,
        label: `${stage} (legacy)`,
        count,
      }));
    return [
      { value: "__unset__", label: "Unset", count: unset },
      ...named,
      ...legacy,
    ];
  }, [customers, overrides, lifecycleOptions]);

  // Flat list of customers whose nextRenewalDate falls in the picked
  // month, after all filters apply. Sorted ascending by renewal date
  // — earliest first within the month so a CSM scans top-down in
  // time order.
  const visibleEntries = useMemo(() => {
    let list = customers.filter((c) => intervalBucket(c) !== "monthly");
    if (intervalFilter) {
      list = list.filter((c) => intervalBucket(c) === intervalFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((c) => {
        const csmRaw = c.customer_success_manager ?? null;
        const csmHuman = csmRaw?.replace(/_/g, " ") ?? null;
        const pubs = c.workspace_id ? ws2pubs[c.workspace_id] ?? [] : [];
        if (
          c.company_name?.toLowerCase().includes(q) ||
          c.workspace_name?.toLowerCase().includes(q) ||
          c.owner_email?.toLowerCase().includes(q) ||
          c.workspace_id?.toLowerCase().includes(q) ||
          c.stripe_customer_id?.toLowerCase().includes(q) ||
          csmRaw?.toLowerCase().includes(q) ||
          csmHuman?.toLowerCase().includes(q)
        ) {
          return true;
        }
        return pubs.some((p) => p.toLowerCase().includes(q));
      });
    }
    if (needsReviewFilter === "1") {
      list = list.filter((c) =>
        c.workspace_id
          ? needsReview(reviewStates[c.workspace_id], "renewals")
          : true
      );
    }
    if (lifecycleFilter) {
      if (lifecycleFilter === "__unset__") {
        list = list.filter((c) => !lifecycleStage(c));
      } else {
        list = list.filter((c) => lifecycleStage(c) === lifecycleFilter);
      }
    }
    if (featureMatcher) {
      list = list.filter((c) => featureMatcher(c.workspace_id));
    }
    // For each customer, surface whichever of (prior renewal, next
    // renewal) falls in the picked month — never both, since the same
    // customer's prior and next dates are always at least a full
    // cadence cycle apart and thus can't coexist in one calendar
    // month. `renewed` distinguishes a confirmed-past renewal (derived
    // from priorRenewalDate) from an upcoming one.
    const enriched: Array<{
      c: Customer;
      date: string | null;
      day: Date | null;
      renewed: boolean;
    }> = [];
    for (const c of list) {
      const priorIso = priorRenewalDate(c);
      const priorDay = priorIso ? new Date(priorIso) : null;
      if (inMonth(priorDay, month)) {
        enriched.push({ c, date: priorIso, day: priorDay, renewed: true });
        continue;
      }
      const nextIso = nextRenewalDate(c);
      const nextDay = nextIso ? new Date(nextIso) : null;
      if (inMonth(nextDay, month)) {
        enriched.push({ c, date: nextIso, day: nextDay, renewed: false });
      }
    }
    enriched.sort((a, b) => {
      const av = a.day?.getTime() ?? 0;
      const bv = b.day?.getTime() ?? 0;
      return av - bv;
    });
    return enriched;
  }, [
    customers,
    intervalFilter,
    search,
    ws2pubs,
    needsReviewFilter,
    reviewStates,
    lifecycleFilter,
    overrides,
    month,
    featureMatcher,
  ]);

  const visibleRows = useMemo(
    () =>
      visibleEntries.map((entry, idx) => ({
        ...entry,
        idx,
        key: rowKey(entry.c, idx),
      })),
    [visibleEntries]
  );

  const selectedCustomers = useMemo(
    () => visibleRows.filter((r) => selected.has(r.key)).map((r) => r.c),
    [visibleRows, selected]
  );

  const selectedWorkspaceIds = useMemo(
    () =>
      selectedCustomers
        .map((c) => c.workspace_id)
        .filter((id): id is string => Boolean(id)),
    [selectedCustomers]
  );

  // Roll-up: total ARR + split between already-renewed and upcoming
  // so the headline gives a CSM the full picture of the month at a
  // glance ("23 renewals · $X ARR · 14 renewed, 9 upcoming").
  const totalArr = useMemo(
    () => visibleRows.reduce((sum, r) => sum + (r.c.arr ?? 0), 0),
    [visibleRows]
  );
  const renewedCount = useMemo(
    () => visibleRows.filter((r) => r.renewed).length,
    [visibleRows]
  );
  const upcomingCount = visibleRows.length - renewedCount;

  const isCurrentMonth = month === thisMonthKey();
  const isPastMonth = month < thisMonthKey();

  const filterStrip = (
    <FilterBar>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search name, owner, CSM, workspace / publication ID…"
      />
      <CsmSelector csms={csms} />
      <SelectFilter
        label="Month"
        value={month}
        onChange={setMonth}
        emptyLabel="Pick a month"
        // No `emptyCount` — month is required, not optional. The
        // dropdown always opens with a value selected (defaults to
        // current month above).
        options={monthOptions}
      />
      <button
        type="button"
        onClick={() => setMonth(thisMonthKey())}
        disabled={isCurrentMonth}
        className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-default"
        title="Jump to the current calendar month"
      >
        This month
      </button>
      <button
        type="button"
        onClick={() => setMonth((prev) => previousMonthKey(prev))}
        className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        title="Step back one calendar month"
      >
        ← Previous month
      </button>
      <SelectFilter
        label="Cadence"
        value={intervalFilter}
        onChange={(v) => setIntervalFilter(v)}
        emptyLabel="All cadences"
        emptyCount={nonMonthlyCount}
        options={intervalOptions}
      />
      <SelectFilter
        label="Lifecycle"
        value={lifecycleFilter}
        onChange={setLifecycleFilter}
        emptyLabel="Any lifecycle"
        options={lifecycleFilterOptions}
      />
    </FilterBar>
  );

  return (
    <div className="space-y-4">
      <FeatureUtilizationFilter
        workspaceIds={featureWorkspaceIds}
        onFilterChange={onFeatureFilterChange}
        totalRowCount={customers.length}
      />
      {filterStrip}

      {/* Softened data caveat — surfaced only when viewing a past
       *  month. The prior-renewal inference catches the rolled-forward
       *  case, but churned / non-renewed customers (where the date
       *  was cleared on cancellation) are still invisible. */}
      {isPastMonth ? (
        <div className="text-xs text-muted bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md px-3 py-2">
          <strong className="text-amber-900 dark:text-amber-200">
            Heads up:
          </strong>{" "}
          Past renewals are inferred by subtracting the customer&rsquo;s
          cadence from their current{" "}
          <code className="font-mono bg-surface px-1 rounded">
            renewal_date
          </code>
          . Customers who churned or whose Stripe cadence changed mid-
          cycle may be missing from this list — a KV-backed historical
          renewal log is the right long-term fix.
        </div>
      ) : null}

      <div className="text-xs text-muted">
        <strong className="text-fg">{visibleRows.length}</strong>{" "}
        renewal{visibleRows.length === 1 ? "" : "s"} in{" "}
        {monthLabel(month)}
        {totalArr > 0 ? (
          <>
            {" · "}
            <strong className="text-fg">{fmtCurrency(totalArr)}</strong>{" "}
            ARR
          </>
        ) : null}
        {renewedCount > 0 && upcomingCount > 0 ? (
          <>
            {" · "}
            <span className="text-emerald-700 dark:text-emerald-300">
              {renewedCount} renewed
            </span>
            , {upcomingCount} upcoming
          </>
        ) : renewedCount > 0 ? (
          <>
            {" · "}
            <span className="text-emerald-700 dark:text-emerald-300">
              all {renewedCount} already renewed
            </span>
          </>
        ) : visibleRows.length > 0 ? (
          <>{" · all upcoming"}</>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          <strong>{selected.size}</strong> selected
        </span>
        <button
          onClick={() => setSelected(new Set(visibleRows.map((r) => r.key)))}
          disabled={visibleRows.length === 0}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
          title="Select every visible row (after filters)"
        >
          Select all
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        >
          Clear
        </button>
        <CopyPubIdsButton workspaceIds={selectedWorkspaceIds} />
        <BulkReviewStateActions
          workspaceIds={selectedWorkspaceIds}
          workflow="renewals"
          onApplied={setReviewStates}
        />
        <PingSelectedButton
          workspaceIds={selectedWorkspaceIds}
          workflow="renewals"
        />
        <div className="flex-1" />
        <BulkEmailLauncher
          customers={selectedCustomers}
          defaultTemplateId="renewal-30d"
          disabled={selected.size === 0}
          label="✉️ Email selected (CCs CSM)"
          ccLookup={(c) => c.customer_success_manager_email ?? null}
          trackingIdFor={(c) => c.workspace_id ?? null}
          auditLabel="Renewal email sent"
        />
      </div>

      {visibleRows.length === 0 ? (
        <div className="bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-lg p-4 text-sm text-green-900 dark:text-green-200">
          No renewals in {monthLabel(month)}
          {intervalFilter ? ` for ${bucketLabel(intervalFilter)} customers` : ""}
          {lifecycleFilter
            ? lifecycleFilter === "__unset__"
              ? " with unset lifecycle"
              : ` at lifecycle "${lifecycleFilter}"`
            : ""}
          .
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm bg-surface table-fixed">
            <colgroup>
              <col className="w-8" />
              <col className="w-6" />
              <col className="w-[20%]" />
              <col className="w-[9%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[11%]" />
              <col className="w-[11%]" />
              <col className="w-[9%] hidden lg:table-cell" />
              <col className="w-[13%]" />
            </colgroup>
            <thead>
              <tr className="text-left border-b border-border text-xs text-muted bg-canvas/40">
                <th className="px-3 py-2"></th>
                <th className="px-3 py-2"></th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium text-right">
                  Renewal price
                </th>
                <th className="px-3 py-2 font-medium">Risk</th>
                <th className="px-3 py-2 font-medium">Renewal</th>
                <th className="px-3 py-2 font-medium">Lifecycle</th>
                <th className="px-3 py-2 font-medium">Review</th>
                <th className="px-3 py-2 font-medium hidden lg:table-cell">
                  CSM
                </th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ c, date, key, renewed }) => {
                const isOpen = expanded.has(key);
                const cadenceLabel = cadenceRowLabel(c);
                const arrBillingSuffix = billingPeriodSuffix(c);
                return (
                  <Fragment key={key}>
                    <tr
                      onClick={() => toggleExpanded(key)}
                      className={`border-b border-border align-top cursor-pointer transition-colors ${
                        isOpen
                          ? "bg-blue-50 dark:bg-blue-500/40"
                          : "hover:bg-blue-50 dark:bg-blue-500/40"
                      }`}
                    >
                      <td
                        className="px-3 py-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => toggleSelected(key)}
                          className="h-4 w-4 rounded border-border-strong cursor-pointer"
                          aria-label={`Select ${
                            c.company_name ?? c.workspace_name ?? "row"
                          }`}
                        />
                      </td>
                      <td className="px-3 py-2 text-subtle select-none">
                        <span
                          className={`inline-block transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        >
                          ▸
                        </span>
                      </td>
                      <td className="px-3 py-2 break-words">
                        <div className="font-medium text-fg">
                          {c.company_name ?? c.workspace_name ?? "—"}
                        </div>
                        <div className="text-xs text-muted break-words">
                          {c.property_main_contact ?? c.owner_email ?? ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        {fmtCurrency(c.arr)}
                        {arrBillingSuffix ? (
                          <div className="text-[10px] text-muted font-normal">
                            {arrBillingSuffix}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <RiskLevelChip
                          level={c.property_risk_level}
                          detail={c.property_risk_level_detail}
                        />
                      </td>
                      <td className="px-3 py-2 text-muted">
                        <div className="flex items-center gap-1.5">
                          <span>{fmtDate(date ?? null)}</span>
                          {renewed ? (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-500/40"
                              title="Inferred prior renewal — derived by subtracting the customer's cadence from their current renewal_date."
                            >
                              ✓ Renewed
                            </span>
                          ) : null}
                        </div>
                        {cadenceLabel ? (
                          <div className="text-xs text-muted">
                            {cadenceLabel}
                          </div>
                        ) : null}
                      </td>
                      <td
                        className="px-3 py-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.workspace_id ? (
                          <LifecycleDropdown
                            options={lifecycleOptions}
                            current={
                              overrides[c.workspace_id]?.lifecycle_stage ?? ""
                            }
                            onChange={(stage) =>
                              void setLifecycle(c.workspace_id!, stage)
                            }
                            updatedAt={
                              overrides[c.workspace_id]
                                ?.lifecycle_stage_updated_at ?? null
                            }
                            updatedBy={
                              overrides[c.workspace_id]
                                ?.lifecycle_stage_updated_by ?? null
                            }
                          />
                        ) : (
                          <span className="text-xs text-subtle italic">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <ReviewStateCell
                          workspaceId={c.workspace_id}
                          workflow="renewals"
                          current={
                            c.workspace_id
                              ? reviewStates[c.workspace_id]
                              : undefined
                          }
                          onChange={(next) => {
                            if (c.workspace_id) {
                              onReviewChange(c.workspace_id, next);
                            }
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 text-muted hidden lg:table-cell break-words">
                        {c.customer_success_manager?.replace(/_/g, " ") ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <RowActions
                          customer={c}
                          onDraft={setOutreachFor}
                          primaryAction="stripe"
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-blue-50 dark:bg-blue-500/20 border-b border-border">
                        <td colSpan={10} className="px-6 py-4">
                          <CustomerDetailPanel customer={c} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {outreachFor ? (
        <OutreachModal
          customer={outreachFor}
          onClose={() => setOutreachFor(null)}
          initialScenario="renewal-30d"
        />
      ) : null}
    </div>
  );
}

/** Inline dropdown for the Lifecycle column. Mirrors the helper in
 *  renewal-panel.tsx; duplicated for now per plan (extract to a shared
 *  util later if a third surface needs it). */
function LifecycleDropdown({
  options,
  current,
  onChange,
  updatedAt,
  updatedBy,
}: {
  options: string[];
  current: string;
  onChange: (stage: string) => void;
  updatedAt: string | null;
  updatedBy: string | null;
}) {
  const inList = current === "" || options.includes(current);
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1 text-xs border border-border-strong rounded-md bg-surface"
      title={
        updatedAt
          ? `Set ${fmtDate(updatedAt)}${updatedBy ? ` by ${updatedBy}` : ""}`
          : "Mark this account's lifecycle stage. Configurable list lives at /settings/slack."
      }
    >
      <option value="">—</option>
      {options.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
      {!inList ? (
        <option value={current}>{current} (legacy)</option>
      ) : null}
    </select>
  );
}
