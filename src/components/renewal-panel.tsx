"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtDate, daysUntil } from "./format";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RiskLevelChip } from "./risk-level-chip";
import { RowActions } from "./row-actions";
import { FilterBar, SearchInput, SelectFilter } from "./filters";
import { CsmSelector } from "./csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import {
  DEFAULT_LIFECYCLE_STAGES,
  type SettingsShape,
} from "@/lib/data/settings-types";
import type { OverrideMap } from "@/lib/data/customer-overrides";
import type {
  ReviewState,
  ReviewStatesMap,
} from "@/lib/data/review-states-types";
import { needsReview } from "@/lib/data/review-states-types";
import { ReviewStateCell } from "./am/review-state-cell";
import { SendDigestButton } from "./am/send-digest-button";

/**
 * Computes the customer's next renewal/charge date.
 *
 * Monthly customers' `next_invoice` from Stripe can drift far past 30 days
 * (it represents the end of the current paid period, not the next monthly
 * charge). For monthly cadences we instead take the day-of-month from
 * next_invoice and roll forward to the next occurrence from today.
 *
 * Annual / other cadences use the date as-is.
 */
function nextRenewalDate(c: Customer): string | null {
  const baseStr = c.next_invoice ?? c.renewal_date;
  if (!baseStr) return null;
  const base = new Date(baseStr);
  if (isNaN(base.getTime())) return null;

  const interval = (c.interval ?? "").toLowerCase();
  const isMonthly = interval === "month" || interval === "monthly";
  if (!isMonthly) return baseStr;

  const day = base.getUTCDate();
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  let candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day);
  if (candidate < today) {
    candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day);
  }
  return new Date(candidate).toISOString();
}

interface Props {
  customers: Customer[];
  csms: string[];
}

interface Bucket {
  label: string;
  detail: string;
  color: string;
  match: (days: number) => boolean;
}

const BUCKETS: Bucket[] = [
  {
    label: "Past due",
    detail: "renewal date in the past",
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
    match: (d) => d < 0,
  },
  {
    label: "≤ 30 days",
    detail: "in the next 30 days",
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
    match: (d) => d >= 0 && d <= 30,
  },
  {
    label: "31–60 days",
    detail: "31–60 days out",
    color: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900",
    match: (d) => d > 30 && d <= 60,
  },
  {
    label: "61–90 days",
    detail: "61–90 days out",
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
    match: (d) => d > 60 && d <= 90,
  },
];

/**
 * Collapse a customer's billing cadence to a canonical bucket so the
 * cadence dropdown doesn't duplicate entries. Honors two signals:
 *
 *   1. `interval_count` (months between charges, sourced from
 *      Metabase q23101 at sync time) — wins when set, because a
 *      customer billed every 3 months has `interval: "month"` from
 *      Stripe and would otherwise mis-bucket as Monthly.
 *
 *   2. The raw `interval` string ("month" / "monthly" / "year" /
 *      "annual" / "yearly") — fallback for rows that don't have an
 *      interval_count populated (the majority — most customers are
 *      a true monthly or annual).
 *
 * Returns short snake-case bucket ids that the renewal-table filter
 * predicates compare against directly.
 */
function intervalBucket(c: {
  interval: string | null;
  interval_count?: number | null;
}): string {
  // Multi-month signal wins. The dropdown bucket names need to match
  // bucketLabel() below so the filter chip + the dropdown agree.
  const count = c.interval_count;
  if (typeof count === "number" && count > 0) {
    if (count === 1) return "monthly";
    if (count === 3) return "quarterly";
    if (count === 4) return "every_4_months";
    if (count === 6) return "semi_annual";
    if (count === 12) return "annual";
    if (count === 24) return "biennial";
    if (count === 36) return "triennial";
    // Generic catch-all for any other multi-month cadence we haven't
    // hand-labeled yet. Key encodes the count so distinct values
    // bucket separately ("every_5_months" vs "every_7_months").
    return `every_${count}_months`;
  }
  // Fallback to the raw interval string.
  if (!c.interval) return "";
  const t = c.interval.trim().toLowerCase();
  if (t === "month" || t === "monthly") return "monthly";
  if (t === "year" || t === "annual" || t === "yearly") return "annual";
  return t;
}

function bucketLabel(bucket: string): string {
  switch (bucket) {
    case "monthly":
      return "Monthly";
    case "quarterly":
      return "Quarterly";
    case "every_4_months":
      return "Every 4 months";
    case "semi_annual":
      return "Semi-annual";
    case "annual":
      return "Annual";
    case "biennial":
      return "Biennial";
    case "triennial":
      return "Triennial";
    default: {
      // Catch-all decoding for the every_N_months synthetic
      // buckets — surfaces e.g. "Every 5 months" without an
      // explicit case above. Falls back to title-casing the raw
      // bucket string for anything we don't recognize.
      const m = bucket.match(/^every_(\d+)_months$/);
      if (m) return `Every ${m[1]} months`;
      return bucket.charAt(0).toUpperCase() + bucket.slice(1);
    }
  }
}

export function RenewalPanel({ customers, csms }: Props) {
  const [selected, setSelected] = useState<Customer | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Default to "annual" — the Renewals motion is fundamentally about
  // annual contracts (multi-year reads as Annual at the bucket level
  // too). Monthly accounts churn out organically and don't need
  // renewal outreach. The Non-monthly synthetic bucket stays in the
  // dropdown as a future-proof option for when new non-monthly
  // cadences (semi-annual, biennial) land, but the user-facing
  // default is the precise label the team actually thinks about.
  const [intervalFilter, setIntervalFilter] = useState<string>("annual");
  const [search, setSearch] = useUrlSearch("q");
  const { ws2pubs } = usePublicationsIndex();
  // Per-workspace lifecycle overrides + the configured option list,
  // fetched once on mount. The lifecycle dropdown POSTs back to
  // /api/customer-overrides which busts loadCustomers cache, so a
  // page-level router.refresh() picks up the new value on the next
  // render tick — we also locally update the overrides map so the
  // dropdown reflects the change without waiting for the refresh.
  const [overrides, setOverrides] = useState<OverrideMap>({});
  const [lifecycleOptions, setLifecycleOptions] = useState<string[]>(
    DEFAULT_LIFECYCLE_STAGES
  );
  // Per-workflow review-state map. Drives the Review dropdown +
  // the ?needs_review filter that scopes the panel to rows still
  // pending action (reach_out / no decision).
  const [reviewStates, setReviewStates] = useState<ReviewStatesMap>({});
  const [needsReviewFilter, setNeedsReviewFilter] = useUrlSearch("needs_review");
  useEffect(() => {
    fetch("/api/customer-overrides")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setOverrides(j as OverrideMap))
      .catch(() => {});
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const s = (j as SettingsShape | null)?.am?.lifecycle_stages;
        if (Array.isArray(s) && s.length > 0) setLifecycleOptions(s);
      })
      .catch(() => {});
    fetch("/api/review-states")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setReviewStates(j as ReviewStatesMap))
      .catch(() => {});
  }, []);

  /** Apply the dropdown's new state to the local map so the next
   *  render reflects the change without waiting for a refetch. */
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
      // Optimistic local update so the dropdown reflects the choice
      // immediately even if the round-trip is slow.
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
        /* non-fatal — optimistic update stays */
      }
    },
    []
  );

  // Reset row-level state when the underlying customer set changes (CSM
  // filter / segment switch). Without this, "expanded" keeps stale
  // workspace IDs and the cadence dropdown shows a count that doesn't
  // match the rendered table.
  const customerSignature = useMemo(
    () => customers.map((c) => c.workspace_id ?? "").sort().join("|"),
    [customers]
  );
  useEffect(() => {
    setExpanded(new Set());
    setIntervalFilter("");
    setSearch("");
  }, [customerSignature]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * Bucketed cadence options + counts. We group on the canonical
   * bucket so "month"/"monthly" and "year"/"annual"/"yearly" each
   * collapse into a single dropdown row. The bucket string also
   * becomes the filter value, and the row predicate below buckets
   * each customer's interval before comparing.
   */
  const intervalOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let nonMonthly = 0;
    for (const c of customers) {
      const bucket = intervalBucket(c);
      if (!bucket) continue;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      if (bucket !== "monthly") nonMonthly++;
    }
    // "Non-monthly" gets pinned to the top of the list as a curated
    // option so the team can switch back to it after picking a
    // specific cadence. Its count reflects everything that isn't
    // monthly — annuals today, plus any future cadences the
    // intervalBucket() helper learns about.
    const named = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, count]) => ({
        value: bucket,
        label: bucketLabel(bucket),
        count,
      }));
    return [
      { value: "non_monthly", label: "Non-monthly", count: nonMonthly },
      ...named,
    ];
  }, [customers]);

  const filtered = useMemo(() => {
    let list = customers;
    if (intervalFilter === "non_monthly") {
      // Synthetic bucket: everything whose canonical interval bucket
      // isn't "monthly". A row with a missing / unrecognized interval
      // still passes — better to surface it for review than to hide
      // it under the default filter.
      list = list.filter((c) => intervalBucket(c) !== "monthly");
    } else if (intervalFilter) {
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
    // ?needs_review=1 scopes to rows still pending action (no
    // decision or explicitly "reach_out"). Drops "skip" + "done"
    // so a CSM clicking the digest link sees only what's left
    // to triage.
    if (needsReviewFilter === "1") {
      list = list.filter((c) =>
        c.workspace_id
          ? needsReview(reviewStates[c.workspace_id], "renewals")
          : true
      );
    }
    return list;
  }, [customers, intervalFilter, search, ws2pubs, needsReviewFilter, reviewStates]);

  const buckets = useMemo(() => {
    return BUCKETS.map((b) => {
      const list = filtered
        .map((c) => {
          const date = nextRenewalDate(c);
          return { c, date, days: daysUntil(date) };
        })
        .filter(({ days }) => days != null && b.match(days as number))
        .sort((a, b) => b.c.arr - a.c.arr);
      return { bucket: b, list };
    });
  }, [filtered]);

  const totalInWindow = buckets.reduce((s, x) => s + x.list.length, 0);

  const cadencePicker = (
    <FilterBar>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search name, owner, CSM, workspace / publication ID…"
      />
      <CsmSelector csms={csms} />
      <SelectFilter
        label="Cadence"
        value={intervalFilter}
        onChange={(v) => setIntervalFilter(v)}
        emptyLabel="All cadences"
        emptyCount={customers.filter((c) => c.interval).length}
        options={intervalOptions}
      />
      <SendDigestButton workflows={["renewals"]} />
    </FilterBar>
  );

  if (totalInWindow === 0) {
    return (
      <>
        {cadencePicker}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No renewals in the next 90 days
          {intervalFilter ? ` for ${bucketLabel(intervalFilter)} customers` : ""}.
        </div>
      </>
    );
  }

  return (
    <div className="space-y-6">
      {cadencePicker}
      {buckets.map(({ bucket, list }, bucketIdx) =>
        list.length === 0 ? null : (
          <div
            key={bucket.label}
            className={`border rounded-lg overflow-hidden ${bucket.color}`}
          >
            <div className="px-4 py-2.5 flex items-baseline justify-between">
              <h3 className="font-semibold">{bucket.label}</h3>
              <span className="text-xs">
                {list.length} account{list.length === 1 ? "" : "s"} · {bucket.detail}
              </span>
            </div>
            <table className="w-full text-sm bg-surface table-fixed">
              <colgroup>
                <col className="w-8" />
                <col className="w-[20%]" />
                <col className="w-[9%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[6%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[9%] hidden lg:table-cell" />
                {/* Actions — stacked Masquerade / HubSpot / Draft. */}
                <col className="w-[13%]" />
              </colgroup>
              <thead>
                <tr className="text-left border-y border-border text-xs text-muted">
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 font-medium text-right">
                    Renewal price
                  </th>
                  <th className="px-3 py-2 font-medium">Risk</th>
                  <th className="px-3 py-2 font-medium">Renewal</th>
                  <th className="px-3 py-2 font-medium">Days</th>
                  <th className="px-3 py-2 font-medium">Lifecycle</th>
                  <th className="px-3 py-2 font-medium">Review</th>
                  <th className="px-3 py-2 font-medium hidden lg:table-cell">CSM</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {list.map(({ c, date, days }, idx) => {
                  const k = `${bucketIdx}-${c.workspace_id ?? idx}`;
                  const isOpen = expanded.has(k);
                  return (
                    <Fragment key={k}>
                      <tr
                        onClick={() => toggleExpanded(k)}
                        className={`border-b border-border align-top cursor-pointer transition-colors ${
                          isOpen ? "bg-blue-50 dark:bg-blue-500/40" : "hover:bg-blue-50 dark:bg-blue-500/40"
                        }`}
                      >
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
                          <div className="text-xs text-muted truncate">
                            {c.property_main_contact ?? c.owner_email ?? ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {fmtCurrency(c.arr)}
                          {c.interval ? (
                            <div className="text-[10px] text-muted font-normal">
                              {c.interval === "month" ? "/mo billing" : "/yr"}
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
                          <div>{fmtDate(date ?? null)}</div>
                          {c.interval ? (
                            <div className="text-xs text-muted">
                              {c.interval === "month" ? "monthly" : c.interval}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 font-medium text-fg">
                          {days}
                        </td>
                        <td
                          className="px-3 py-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.workspace_id ? (
                            <LifecycleDropdown
                              options={lifecycleOptions}
                              current={
                                overrides[c.workspace_id]?.lifecycle_stage ??
                                ""
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
                            <span className="text-xs text-subtle italic">
                              —
                            </span>
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
                          <RowActions customer={c} onDraft={setSelected} />
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
        )
      )}

      {selected && (
        <OutreachModal
          customer={selected}
          onClose={() => setSelected(null)}
          initialScenario="renewal-30d"
        />
      )}
    </div>
  );
}

/** Inline dropdown for the Lifecycle column. POSTs to
 *  /api/customer-overrides on each change; the row caller handles the
 *  optimistic local update so the dropdown reflects the choice
 *  before the round-trip resolves. If a saved stage isn't in the
 *  current settings list (admin removed it after-the-fact), it still
 *  renders as a "(legacy)" option so the value stays visible until
 *  someone picks a configured one. */
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
