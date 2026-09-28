"use client";

import { useMemo, useState } from "react";
import { fmtDate, fmtNumber } from "./format";
import {
  buildFacet,
  EMPTY_SELECTIONS,
  ENDING_SOON_DAYS,
  formatCents,
  formatFlightDate,
  formatTier,
  matchesSearch,
  matchesSelections,
  summarize,
  type AdCampaignRow,
  type FacetKey,
  type Selections,
} from "@/lib/engines/ad-campaigns-types";

/**
 * Live Ad Network Campaigns view.
 *
 * All filtering happens client-side. The whole set is ~51 rows, so
 * fetching once and filtering in memory keeps facet counts instant —
 * a round-trip per chip click would make the counts feel laggy for no
 * benefit at this size. Revisit if the active-campaign count grows
 * past a few hundred.
 */

const FACETS: Array<{ key: FacetKey; label: string; hint?: string }> = [
  { key: "content_tags", label: "Content" },
  {
    key: "targeting_tags",
    label: "Targeting",
    hint: "Set on a minority of campaigns — an empty result here usually means untagged, not unmatched.",
  },
  {
    key: "industry_groups",
    label: "Industry",
    hint: "Advertiser-level and sparsely populated.",
  },
  { key: "tier", label: "Tier" },
  { key: "payout_model", label: "Payout" },
];

export function AdCampaignsView({
  rows,
  fetchedAt,
}: {
  rows: AdCampaignRow[];
  fetchedAt: string;
}) {
  const [selections, setSelections] = useState<Selections>(EMPTY_SELECTIONS);
  const [search, setSearch] = useState("");

  const visible = useMemo(
    () =>
      rows.filter(
        (r) => matchesSearch(r, search) && matchesSelections(r, selections)
      ),
    [rows, search, selections]
  );
  const summary = useMemo(() => summarize(visible), [visible]);

  const facets = useMemo(
    () =>
      FACETS.map((f) => ({
        ...f,
        options: buildFacet(rows, f.key, selections, search),
      })),
    [rows, selections, search]
  );

  const activeCount =
    Object.values(selections).reduce((n, v) => n + v.length, 0) +
    (search.trim() ? 1 : 0);

  function toggle(key: FacetKey, value: string) {
    setSelections((prev) => {
      const chosen = prev[key];
      return {
        ...prev,
        [key]: chosen.includes(value)
          ? chosen.filter((v) => v !== value)
          : [...chosen, value],
      };
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Campaigns" value={fmtNumber(summary.campaigns)} />
        <Stat label="Advertisers" value={fmtNumber(summary.advertisers)} />
        <Stat
          label={`Ending ≤ ${ENDING_SOON_DAYS}d`}
          value={fmtNumber(summary.ending_soon)}
          tone={summary.ending_soon > 0 ? "warn" : undefined}
        />
        <Stat
          label="Avg CPC"
          value={formatCents(summary.avg_cpc_cents) ?? "—"}
          hint={
            summary.avg_cpc_cents == null
              ? "No rate set on any visible campaign"
              : "Across campaigns with a rate set"
          }
        />
      </div>

      <div className="rounded-xl border border-border bg-surface p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search advertiser, campaign, goal, promoted item, tags…"
            className="flex-1 min-w-[16rem] px-3 py-1.5 text-sm bg-surface border border-border-strong rounded-md text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            onClick={() => {
              setSelections(EMPTY_SELECTIONS);
              setSearch("");
            }}
            disabled={activeCount === 0}
            className="px-3 py-1.5 text-xs rounded-md border border-border-strong text-fg hover:bg-canvas disabled:opacity-40"
          >
            Clear all{activeCount > 0 ? ` (${activeCount})` : ""}
          </button>
        </div>

        {facets.map((facet) => (
          <div key={facet.key} className="flex flex-wrap items-baseline gap-1.5">
            <span
              className="text-[11px] uppercase tracking-wide text-subtle w-20 shrink-0"
              title={facet.hint}
            >
              {facet.label}
            </span>
            {facet.options.length === 0 ? (
              <span className="text-[11px] text-muted italic">
                none in the current result
              </span>
            ) : (
              facet.options.map((opt) => {
                const on = selections[facet.key].includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(facet.key, opt.value)}
                    className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                      on
                        ? "bg-accent text-accent-fg border-accent"
                        : "bg-surface text-fg border-border-strong hover:bg-canvas"
                    }`}
                  >
                    {opt.value}
                    <span className={on ? "opacity-80" : "text-muted"}>
                      {" "}
                      {opt.count}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-muted italic">
          No campaigns match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-fg text-left text-xs uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 font-medium">Advertiser / campaign</th>
                <th className="px-3 py-2 font-medium">Content</th>
                <th className="px-3 py-2 font-medium">Targeting / industry</th>
                <th className="px-3 py-2 font-medium">Payout</th>
                <th className="px-3 py-2 font-medium">Flight</th>
                <th className="px-3 py-2 font-medium">Promoting / goal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {visible.map((row) => (
                <CampaignRow key={row.campaign_id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="text-xs text-muted">
        {fmtNumber(visible.length)} of {fmtNumber(rows.length)} active
        campaigns · as of {fmtDate(fetchedAt)}
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3" title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-subtle">
        {label}
      </div>
      <div
        className={`text-2xl font-semibold tabular-nums ${
          tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-fg"
        }`}
      >
        {value}
      </div>
      {hint ? (
        <div className="text-[10px] text-muted mt-0.5 leading-snug">{hint}</div>
      ) : null}
    </div>
  );
}

function TagList({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <span className="text-[11px] text-subtle italic">None</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v) => (
        <span
          key={v}
          className="px-1.5 py-0.5 rounded bg-canvas text-[10px] text-fg border border-border"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

function CampaignRow({ row }: { row: AdCampaignRow }) {
  const cpc = formatCents(row.cpc_cents);
  const cpm = formatCents(row.cpm_cents);
  const rate = cpc ?? cpm;
  const volume =
    row.clicks_goal != null
      ? `${fmtNumber(row.clicks_goal)} clicks`
      : row.impressions_goal != null
        ? `${fmtNumber(row.impressions_goal)} impressions`
        : null;
  // "Ending soon" is only meaningful once a flight is live — a
  // campaign that starts next week and runs two days would otherwise
  // read as urgent when there's nothing to do yet.
  const endingSoon =
    !row.not_started &&
    row.days_until_end != null &&
    row.days_until_end <= ENDING_SOON_DAYS;

  return (
    <tr className="align-top">
      <td className="px-3 py-2 min-w-[15rem]">
        <div className="font-medium text-fg">{row.advertiser}</div>
        <div className="text-[11px] text-muted">{row.campaign}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="px-1.5 py-0.5 rounded bg-canvas text-[10px] text-muted border border-border">
            {formatTier(row.tier)}
          </span>
          {row.geo.length > 0 ? (
            <span className="text-[10px] text-subtle">{row.geo.join(", ")}</span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2 max-w-[12rem]">
        <TagList values={row.content_tags} />
      </td>
      <td className="px-3 py-2 max-w-[12rem] space-y-1">
        <TagList values={row.targeting_tags} />
        {row.industries.length > 0 || row.industry_groups.length > 0 ? (
          <div className="text-[10px] text-muted">
            {[...row.industry_groups, ...row.industries].join(" · ")}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="text-fg text-xs uppercase">
          {row.payout_model ?? "—"}
        </div>
        <div className="text-[11px] text-muted tabular-nums">
          {rate ?? (
            <span className="italic text-subtle">Rate not set</span>
          )}
        </div>
        {volume ? (
          <div className="text-[10px] text-subtle tabular-nums">{volume}</div>
        ) : null}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-[11px]">
        <div className="text-muted">
          {formatFlightDate(row.window_start_date)} →{" "}
          {formatFlightDate(row.window_end_date)}
        </div>
        {row.not_started ? (
          <span className="mt-1 inline-block rounded border border-blue-400 bg-blue-50 dark:bg-blue-500/10 px-1 py-0.5 text-[9px] font-semibold text-blue-800 dark:text-blue-200">
            STARTS {formatFlightDate(row.window_start_date)}
          </span>
        ) : endingSoon ? (
          <span className="mt-1 inline-block rounded border border-amber-400 bg-amber-50 dark:bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold text-amber-800 dark:text-amber-200">
            {row.days_until_end != null && row.days_until_end <= 0
              ? "ENDS TODAY"
              : `ENDS IN ${row.days_until_end}D`}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 max-w-[20rem] space-y-1">
        <LongText label="Promoting" value={row.promoted_item} />
        <LongText label="Goal" value={row.goal} />
      </td>
    </tr>
  );
}

/** Goal and promoted item run from two words to a full paragraph
 *  (Particle for Men's goal is ~120 words). Clamp to one line and
 *  put the rest behind a toggle so a long entry can't blow the row
 *  height out and push everything else off screen. */
function LongText({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (!value) {
    return (
      <div className="text-[11px]">
        <span className="text-subtle">{label}: </span>
        <span className="text-subtle italic">None</span>
      </div>
    );
  }
  const long = value.length > 90;
  return (
    <div className="text-[11px]">
      <span className="text-subtle">{label}: </span>
      <span className={open ? "text-fg" : "text-fg line-clamp-1"}>{value}</span>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-1 text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
        >
          {open ? "less" : "more"}
        </button>
      ) : null}
    </div>
  );
}
