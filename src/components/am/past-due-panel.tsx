"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PastDueRow } from "@/lib/engines/am-cohorts";
import { fmtCurrency, fmtDate } from "../format";
import {
  findSlackChannel,
  PAST_DUE_CHANNEL_ID,
  type SettingsShape,
} from "@/lib/data/settings-types";
import { BucketSection } from "./bucket-section";
import { FilterBar, SearchInput, SegmentToggle } from "../filters";
import { CsmSelector } from "../csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";

interface Props {
  rows: PastDueRow[];
  csms: string[];
}

type PlanTier = "all" | "enterprise" | "non-enterprise";

const BUCKET_STEP_USD = 50_000;

interface BucketRange {
  label: string;
  min: number;
  max: number;
  toneClass: string;
}

function makeBuckets(maxArr: number): BucketRange[] {
  // Buckets are half-open [lo, hi). Round the ceiling STRICTLY above maxArr
  // so a row with arr_dollars equal to a $50K multiple still lands in the
  // top bucket (otherwise the headline-vs-list count drifts).
  //
  //   maxArr = 99,999  →  ceiling = 100,000 (top bucket [50K, 100K) catches it)
  //   maxArr = 100,000 →  ceiling = 150,000 (top bucket [100K, 150K) catches it)
  //   maxArr = 0       →  ceiling = 50,000  (one bucket [0, 50K))
  const ceiling = Math.max(
    BUCKET_STEP_USD,
    Math.floor(Math.max(0, maxArr) / BUCKET_STEP_USD) * BUCKET_STEP_USD +
      BUCKET_STEP_USD
  );
  const ranges: BucketRange[] = [];
  for (let lo = ceiling - BUCKET_STEP_USD; lo >= 0; lo -= BUCKET_STEP_USD) {
    const hi = lo + BUCKET_STEP_USD;
    const isTop = lo >= 100_000;
    ranges.push({
      label: `${fmtCurrency(lo)} – ${fmtCurrency(hi)}`,
      min: lo,
      max: hi,
      toneClass: isTop
        ? "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900"
        : lo >= 25_000
          ? "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900"
          : "bg-canvas border-border text-fg",
    });
  }
  return ranges;
}

function isEnterprisePlan(p: PastDueRow): boolean {
  // Beehiiv tier ladder: Launch → Scale → Max → Max Plus → Enterprise.
  // "Max" is a paid plan but NOT Enterprise — including it would inflate
  // the headline count and mis-badge ~38 rows in the past-due feed.
  return /enterprise|custom/i.test(p.price_name ?? "");
}

export function PastDuePanel({ rows, csms }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  // Filter state — search and plan-tier are client-side over `rows`;
  // CSM piggybacks on the shared `?csm=` URL param that CsmSelector
  // already writes, so it stays consistent with the rest of the
  // dashboard.
  const [search, setSearch] = useUrlSearch("q");
  const [planTier, setPlanTier] = useState<PlanTier>("all");
  const searchParams = useSearchParams();
  const csmFilter = searchParams.get("csm") ?? "";

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setSettings(j as SettingsShape))
      .catch(() => {});
  }, []);

  // Apply filters to the raw rows BEFORE bucketing so headline counts
  // and the rendered list always agree.
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (csmFilter && r.customer_success_manager !== csmFilter) return false;
      if (planTier === "enterprise" && !isEnterprisePlan(r)) return false;
      if (planTier === "non-enterprise" && isEnterprisePlan(r)) return false;
      if (search) {
        const q = search.toLowerCase();
        const haystack = [
          r.email,
          r.customer_id,
          r.price_name,
          r.customer_success_manager,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [rows, csmFilter, planTier, search]);

  const maxArr = useMemo(
    () => filteredRows.reduce((m, r) => Math.max(m, r.arr_dollars), 0),
    [filteredRows]
  );
  const bucketRanges = useMemo(() => makeBuckets(maxArr), [maxArr]);

  const grouped = useMemo(() => {
    return bucketRanges
      .map((b) => ({
        bucket: b,
        list: filteredRows
          .filter((r) => r.arr_dollars >= b.min && r.arr_dollars < b.max)
          .sort((a, b2) => b2.arr_dollars - a.arr_dollars),
      }))
      .filter((g) => g.list.length > 0);
  }, [filteredRows, bucketRanges]);

  // Compute headline stats from the SAME rows the buckets actually render so
  // the "Past-due Enterprise" count and the visible ENT rows can never drift.
  const visibleRows = useMemo(
    () => grouped.flatMap((g) => g.list),
    [grouped]
  );
  // Diff is against the filtered set so the warning only fires for rows
  // that ARE supposed to be in view but couldn't be bucketed.
  const droppedCount = filteredRows.length - visibleRows.length;

  const enterpriseRows = visibleRows.filter(isEnterprisePlan);
  const enterpriseArrTotal = enterpriseRows.reduce(
    (s, r) => s + r.arr_dollars,
    0
  );
  const totalArr = visibleRows.reduce((s, r) => s + r.arr_dollars, 0);

  function rowKey(r: PastDueRow, i: number): string {
    return r.subscription_id ?? r.customer_id ?? `${i}`;
  }

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function selectAllIn(list: PastDueRow[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      list.forEach((r, i) => next.add(rowKey(r, i)));
      return next;
    });
  }

  const totalSourceRows = rows.length;
  const filteredCount = filteredRows.length;
  const filtersActive =
    Boolean(search) || planTier !== "all" || Boolean(csmFilter);

  return (
    <>
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search email, customer id, or plan…"
        />
        <CsmSelector csms={csms} />
        <SegmentToggle<PlanTier>
          options={[
            { value: "all", label: "All plans" },
            { value: "enterprise", label: "Enterprise" },
            { value: "non-enterprise", label: "Non-enterprise" },
          ]}
          value={planTier}
          onChange={setPlanTier}
        />
      </FilterBar>

      {filtersActive ? (
        <p className="text-xs text-muted mb-3">
          Showing <strong className="text-fg">{filteredCount}</strong> of{" "}
          {totalSourceRows} past-due accounts
        </p>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="Past-due accounts" value={String(visibleRows.length)} />
        <Stat
          label="Past-due Enterprise"
          value={String(enterpriseRows.length)}
          accent={enterpriseRows.length > 0}
        />
        <Stat
          label="Enterprise ARR past due"
          value={fmtCurrency(enterpriseArrTotal)}
          accent={enterpriseArrTotal > 0}
        />
        <Stat label="Total ARR past due" value={fmtCurrency(totalArr)} />
      </div>

      {droppedCount > 0 ? (
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-3 text-sm text-amber-900 mb-4">
          {droppedCount} row{droppedCount === 1 ? "" : "s"} from q24620 fell
          outside the ARR buckets (likely due to negative or non-numeric{" "}
          <code className="font-mono px-1 bg-amber-100 rounded">arr_cents</code>
          ) and aren&rsquo;t shown below.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-muted">
          <strong>{selected.size}</strong> selected
        </span>
        <button
          onClick={() =>
            setSelected(new Set(visibleRows.map((r, i) => rowKey(r, i))))
          }
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
          title="Select every account currently visible (after filters)"
        >
          Select all
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        >
          Clear
        </button>
        <button
          onClick={() =>
            setSelected(new Set(enterpriseRows.map((r, i) => rowKey(r, i))))
          }
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        >
          Select Enterprise only
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setComposeOpen(true)}
          disabled={!settings || selected.size === 0}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          title="Send a Slack message about the selected past-due accounts"
        >
          📣 Slack the past-due channel
        </button>
      </div>

      {grouped.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No past-due accounts. Nicely done.
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(({ bucket, list }) => (
            <BucketSection
              key={bucket.label}
              label={bucket.label}
              count={list.length}
              detail={`${fmtCurrency(
                list.reduce((s, r) => s + r.arr_dollars, 0)
              )} ARR`}
              toneClass={bucket.toneClass}
              defaultOpen
            >
              <div className="px-3 py-1.5 border-b border-border flex justify-end">
                <button
                  onClick={() => selectAllIn(list)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Select all in tier
                </button>
              </div>
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-8" />
                  <col className="w-[24%]" />
                  <col className="w-[20%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[14%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs text-muted border-b border-border text-left">
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 font-medium text-right">ARR</th>
                    <th className="px-3 py-2 font-medium text-right">
                      Failed charge
                    </th>
                    <th className="px-3 py-2 font-medium">Attempted</th>
                    <th className="px-3 py-2 font-medium">CSM</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => {
                    const k = rowKey(r, i);
                    const isEnt = isEnterprisePlan(r);
                    return (
                      <tr
                        key={k}
                        className="border-b border-border hover:bg-blue-50 dark:bg-blue-500/40 align-top"
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selected.has(k)}
                            onChange={() => toggleSelected(k)}
                            className="h-4 w-4 rounded border-border-strong cursor-pointer"
                            aria-label={`Select ${r.email ?? "row"}`}
                          />
                        </td>
                        <td className="px-3 py-2 break-words">
                          <div className="font-medium text-fg">
                            {r.email ?? "—"}
                          </div>
                          <div className="text-xs text-muted truncate font-mono">
                            {r.customer_id ?? ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted break-words">
                          <div>{r.price_name ?? "—"}</div>
                          {isEnt ? (
                            <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:text-emerald-300">
                              ENT
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {fmtCurrency(r.arr_dollars)}
                        </td>
                        <td className="px-3 py-2 text-right text-red-700 font-medium">
                          {fmtCurrency(r.charge_amount_dollars)}
                          {r.failure_code ? (
                            <div className="text-[10px] text-muted">
                              {r.failure_code}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-muted text-xs">
                          {fmtDate(r.charge_attempted_at)}
                        </td>
                        <td className="px-3 py-2 text-muted break-words">
                          {r.customer_success_manager?.replace(/_/g, " ") ?? (
                            <span className="text-subtle italic">
                              unassigned
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </BucketSection>
          ))}
        </div>
      )}

      <p className="text-xs text-subtle mt-2">
        Source: Metabase q24620 — past-due subscriptions with customer details.
        ARR / charge amounts converted from cents.
      </p>

      {composeOpen && settings ? (
        <SlackCompose
          rows={rows.filter((r, i) => selected.has(rowKey(r, i)))}
          settings={settings}
          onClose={() => setComposeOpen(false)}
        />
      ) : null}
    </>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        accent
          ? "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30"
          : "bg-surface border-border"
      }`}
    >
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold mt-0.5">{value}</p>
    </div>
  );
}

/** ----------------- Slack compose modal ----------------- */

/** Default per-row format used when settings.slack.channels[past_due]
 *  has no row_template. Kept in sync with DEFAULTS in settings-types
 *  so freshly-seeded envs render identically to upgraded ones. */
const DEFAULT_PAST_DUE_ROW_TEMPLATE =
  "• *{{email}}* — {{charge_amount}} failed charge, {{arr}} ARR (CSM: {{csm}})";

function csmTagFor(
  csmKey: string | null,
  settings: SettingsShape
): string {
  const key = csmKey ?? "";
  const slackId = settings.slack.csm_user_ids[key];
  if (slackId) return `<@${slackId}>`;
  return (key || "unassigned").replace(/_/g, " ");
}

/** Render a single past-due row through the per-row template. Unknown
 *  tokens render empty so a typo in settings doesn't echo `{{foo}}` out
 *  into a Slack message. */
function renderPastDueRow(
  row: PastDueRow,
  template: string,
  settings: SettingsShape
): string {
  const values: Record<string, string> = {
    email: row.email ?? "—",
    customer_id: row.customer_id ?? "",
    plan: row.price_name ?? "—",
    arr: fmtCurrency(row.arr_dollars),
    charge_amount: fmtCurrency(row.charge_amount_dollars),
    failure_code: row.failure_code ?? "",
    attempted_at: row.charge_attempted_at
      ? fmtDate(row.charge_attempted_at)
      : "",
    csm: csmTagFor(row.customer_success_manager, settings),
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    return name in values ? values[name] : "";
  });
}

function renderSlackTemplate(
  template: string,
  rows: PastDueRow[],
  settings: SettingsShape,
  rowTemplate?: string
): string {
  const total = rows.reduce((s, r) => s + r.arr_dollars, 0);
  const effectiveRowTemplate = (rowTemplate ?? "").trim()
    ? (rowTemplate as string)
    : DEFAULT_PAST_DUE_ROW_TEMPLATE;
  const accountList = rows
    .map((r) => renderPastDueRow(r, effectiveRowTemplate, settings))
    .join("\n");
  // Comma-separated list of Stripe customer IDs from the selected rows.
  // Filter to ids that actually start with `cus_` so junk values (null,
  // legacy IDs) don't leak into a paste-into-Stripe workflow.
  const customerIds = rows
    .map((r) => r.customer_id)
    .filter((id): id is string => !!id && id.startsWith("cus_"))
    .join(", ");
  return template
    .replace(/\{\{\s*total_arr\s*\}\}/g, fmtCurrency(total))
    .replace(/\{\{\s*count\s*\}\}/g, String(rows.length))
    .replace(/\{\{\s*count_plural\s*\}\}/g, rows.length === 1 ? "" : "s")
    .replace(/\{\{\s*account_list\s*\}\}/g, accountList)
    .replace(/\{\{\s*customer_ids\s*\}\}/g, customerIds);
}

function SlackCompose({
  rows,
  settings,
  onClose,
}: {
  rows: PastDueRow[];
  settings: SettingsShape;
  onClose: () => void;
}) {
  // Resolve the past-due channel config from the channels[] list. Falls
  // back to empty strings if /settings/slack hasn't been visited yet —
  // the user can still type the channel id directly in the dialog.
  const pastDueCfg = findSlackChannel(settings.slack, PAST_DUE_CHANNEL_ID);
  const [channel, setChannel] = useState(pastDueCfg?.channel_id ?? "");
  const [text, setText] = useState(() =>
    renderSlackTemplate(
      pastDueCfg?.template ?? "",
      rows,
      settings,
      pastDueCfg?.row_template
    )
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/slack-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setResult("Sent to Slack ✓");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h3 className="font-semibold text-fg">
              Slack the past-due channel
            </h3>
            <p className="text-xs text-muted mt-0.5">
              {rows.length} account{rows.length === 1 ? "" : "s"} selected.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="text-xs text-muted block mb-1">
              Channel ID (e.g. C0AMK142WUR)
            </label>
            <input
              type="text"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="C0AMK142WUR"
              className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
            />
          </div>

          <div>
            <label className="text-xs text-muted block mb-1">Message</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={14}
              className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
            />
          </div>

          {error ? (
            <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
              {error}
            </div>
          ) : null}
          {result ? (
            <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-md p-3 text-sm text-emerald-800 dark:text-emerald-300">
              {result}
            </div>
          ) : null}
        </div>

        <div className="p-4 border-t border-border flex items-center gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={busy || !channel || !text}
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send to Slack"}
          </button>
        </div>
      </div>
    </div>
  );
}
