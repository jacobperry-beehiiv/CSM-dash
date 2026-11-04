"use client";

import { useState } from "react";
import {
  NO_LIST_LABEL,
  TREND_METRIC_DECIMALS,
  type TrendMetric,
} from "@/lib/engines/engagement-trends-types";

/**
 * The red-row warning for a workspace whose engagement is degrading
 * while still inside the deliverability thresholds.
 *
 * Two pieces live here: the hook that fetches the report once for the
 * whole table, and the panel rendered inside an expanded row. The
 * fetch is shared because the customer table renders up to ~600 rows
 * and each one needs an O(1) lookup, not its own request.
 */

export interface TrendPointRow {
  week_start: string;
  week_end: string;
  value: number;
}

export interface TrendWindowRow {
  start: string;
  end: string;
  days: number;
}

export interface TrendListRow {
  list_id: string;
  list_name: string | null;
  recipients_recent: number;
  recipients_baseline: number;
  open_rate_recent: number | null;
  open_rate_baseline: number | null;
  is_new: boolean;
  is_dropped: boolean;
}

export interface TrendMetricRow {
  metric: string;
  recent: number;
  baseline: number;
  delta: number;
  cohort_delta: number;
  weeks_to_threshold: number | null;
  severity: number;
  /** Highest and lowest week by value in the 13-week series, with
   *  trivial-volume weeks already dropped by the engine. Null on a
   *  snapshot written before these existed. */
  high: TrendPointRow | null;
  low: TrendPointRow | null;
  mix_adjusted_delta: number | null;
  mix_delta: number | null;
}

export interface TrendPublicationRow {
  publication_id: string;
  publication_name: string | null;
  severity: number;
  volume_ratio: number;
  volume_confounded: boolean;
  mix_confounded: boolean;
  lists: TrendListRow[];
  metrics: TrendMetricRow[];
}

export interface TrendRow {
  workspace_id: string;
  workspace_name: string | null;
  severity: number;
  summary: string;
  multi_publication: boolean;
  cleared: boolean;
  clear: { cleared_at: string; cleared_by?: string | null } | null;
  publications: TrendPublicationRow[];
}

export interface TrendReport {
  generated_at: string | null;
  recent_days?: number;
  baseline_days?: number;
  /** The dates the sweep actually measured. Null on older snapshots;
   *  the panel then says nothing rather than guessing. */
  recent_window?: TrendWindowRow | null;
  baseline_window?: TrendWindowRow | null;
  data_through?: string | null;
  publications_examined: number;
  rows: Record<string, TrendRow>;
  order: string[];
}

const METRIC_LABELS: Record<string, string> = {
  delivery_rate: "Delivery rate",
  open_rate: "Open rate",
  click_rate: "Click rate",
  hard_bounce_rate: "Hard bounce rate",
  soft_bounce_rate: "Soft bounce rate",
  spam_rate: "Spam rate",
};

/**
 * Decimals for a metric, defaulting to 1 for anything the report
 * grows later. `metric` is a plain string on the wire, so this takes
 * the widening rather than asserting the union is complete.
 */
function dp(metric?: string): number {
  if (!metric) return 1;
  return TREND_METRIC_DECIMALS[metric as TrendMetric] ?? 1;
}

function pct(x: number, metric?: string): string {
  return `${(x * 100).toFixed(dp(metric))}%`;
}

function pts(x: number, metric?: string): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp(metric))}pt`;
}

/**
 * A plain YYYY-MM-DD rendered as the day it says.
 *
 * Formatted in UTC on purpose. These are calendar dates, not
 * instants; `new Date("2026-08-05")` parses as UTC midnight, so
 * rendering it in a US timezone shows "Aug 4" — the report would
 * silently disagree with itself by a day for most of the company.
 */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function shortDateYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Years are shown only when the range straddles one, which a 90-day
 *  window does every January. */
function dateRange(w: TrendWindowRow | null | undefined): string {
  if (!w) return "";
  const sameYear = w.start.slice(0, 4) === w.end.slice(0, 4);
  return sameYear
    ? `${shortDate(w.start)} – ${shortDate(w.end)}`
    : `${shortDateYear(w.start)} – ${shortDateYear(w.end)}`;
}

/** Recipient counts, short enough to sit in a table of lists. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** How many lists to show before the rest collapse. Generous, because
 *  the publications where this matters are exactly the ones with many
 *  lists — one in the book fans out across 19. */
const MAX_LISTED_LISTS = 12;

/**
 * Severity -> row tint.
 *
 * Only two bands on purpose. A five-colour heat scale invites people
 * to read precision into a score that is a weighted blend of three
 * estimates; red vs amber says "look now" vs "worth knowing" and
 * nothing more.
 */
export function trendRowClass(severity: number): string {
  // -100 rather than -50 for both. At -50 the tint was very nearly
  // white against the table's own background and simply did not read
  // as a warning when scanning a dense book; hue carries the severity
  // and the weight has to be enough to notice without hunting.
  return severity >= 70
    ? "bg-red-100 dark:bg-red-500/20 hover:bg-red-200 dark:hover:bg-red-500/30"
    : "bg-amber-100 dark:bg-amber-500/15 hover:bg-amber-200 dark:hover:bg-amber-500/25";
}

// ─── Expanded-row panel ───────────────────────────────────────────

interface Props {
  row: TrendRow;
  /** Called after a successful clear/unclear so the table can re-tint
   *  the row without re-fetching the whole report. */
  onChange: (workspaceId: string, cleared: boolean) => void;
  /**
   * The dates the sweep measured, from the report header.
   *
   * Passed down rather than looked up per row because they are a
   * property of the whole report, and because every rate in this
   * panel is unreadable without them: the sweep is weekly, so "the
   * last 28 days" on a Friday means a window that closed the previous
   * Monday.
   */
  windows?: {
    recent: TrendWindowRow | null;
    baseline: TrendWindowRow | null;
    dataThrough: string | null;
  } | null;
}

/**
 * Per-newsletter-list breakdown for one publication.
 *
 * Collapsed behind a toggle because it answers a question the CSM
 * only sometimes has — "is this one audience getting worse, or did
 * they just change who they mail?" — and because a publication with
 * 19 lists would otherwise push the metrics off the screen.
 */
function ListBreakdown({ lists }: { lists: TrendListRow[] }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (lists.length < 2) return null;

  const listed = showAll ? lists : lists.slice(0, MAX_LISTED_LISTS);
  const hidden = lists.length - listed.length;

  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-accent hover:underline"
      >
        {open ? "Hide" : "Show"} {lists.length} newsletter lists
      </button>
      {open ? (
        // Capped width: the name column is flex-1, so on a wide
        // screen the numbers drift to the far right and stop reading
        // as rows. Keeping the block narrow holds them together.
        <div className="mt-1 space-y-0.5 max-w-2xl">
          {listed.map((l) => (
            <div
              key={l.list_id}
              className="flex items-baseline gap-2 text-[11px] text-muted tabular-nums"
            >
              <span className="min-w-0 flex-1 truncate text-fg">
                {l.list_name ?? NO_LIST_LABEL}
              </span>
              <span className="shrink-0 w-28 text-right">
                {compact(l.recipients_baseline)} →{" "}
                {compact(l.recipients_recent)}
              </span>
              <span className="shrink-0 w-28 text-right">
                {l.open_rate_baseline != null ? pct(l.open_rate_baseline) : "—"}{" "}
                → {l.open_rate_recent != null ? pct(l.open_rate_recent) : "—"}
              </span>
              <span className="shrink-0 w-20 text-right text-subtle">
                {l.is_new ? "new" : l.is_dropped ? "no recent send" : ""}
              </span>
            </div>
          ))}
          {hidden > 0 ? (
            <button
              onClick={() => setShowAll(true)}
              className="text-[11px] text-accent hover:underline"
            >
              Show {hidden} more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * How many publications to list before collapsing the rest.
 *
 * One local-news network in the book has 115 flagged newsletters;
 * rendering them all buries the detail panel below it and makes the
 * expanded row unusable. The top few carry the story — they're sorted
 * worst-first — and the count tells you how deep it goes.
 */
const MAX_LISTED_PUBLICATIONS = 8;

export function TrendWarningPanel({ row, onChange, windows }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const listed = showAll
    ? row.publications
    : row.publications.slice(0, MAX_LISTED_PUBLICATIONS);
  const hidden = row.publications.length - listed.length;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/engagement-trends/clear", {
        method: row.cleared ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: row.workspace_id,
          severity: row.severity,
          summary: row.summary,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onChange(row.workspace_id, !row.cleared);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const tone = row.cleared
    ? "border-border bg-surface"
    : row.severity >= 70
      ? "border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10"
      : "border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10";

  return (
    <div className={`rounded-lg border ${tone} p-3 mb-3`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-fg">
              Engagement declining — still inside thresholds
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-muted tabular-nums">
              severity {row.severity}
            </span>
            {row.multi_publication ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-muted"
                // Spelled out because the inference isn't obvious: one
                // newsletter slipping is usually content or list
                // hygiene; several at once points at the shared
                // sending domain or IP.
                title="More than one newsletter in this workspace is declining at the same time — look at the sending domain or IP reputation, not individual content."
              >
                multi-publication
              </span>
            ) : null}
            {row.cleared ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-subtle">
                cleared
                {row.clear?.cleared_by ? ` by ${row.clear.cleared_by}` : ""}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted mt-0.5">{row.summary}</p>
          {windows?.baseline && windows?.recent ? (
            <p className="text-[11px] text-subtle mt-0.5 tabular-nums">
              Baseline {dateRange(windows.baseline)} ({windows.baseline.days}d)
              {"  ·  "}
              Recent {dateRange(windows.recent)} ({windows.recent.days}d)
              {windows.dataThrough ? (
                <>
                  {"  ·  "}
                  {/* Said out loud because the sweep is weekly and the
                      panel is read daily. Without it the numbers look
                      like today's. */}
                  <span title="The sweep runs weekly, so the newest data here is from the last run, not today.">
                    data ends {shortDate(windows.dataThrough)}
                  </span>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className="shrink-0 text-xs px-2.5 py-1 rounded-md border border-border-strong bg-surface text-fg hover:bg-canvas disabled:opacity-50"
        >
          {busy ? "…" : row.cleared ? "Restore warning" : "Clear warning"}
        </button>
      </div>

      {error ? (
        <p className="text-xs text-red-800 dark:text-red-300 mt-2">{error}</p>
      ) : null}

      <div className="mt-3 space-y-2">
        {listed.map((p) => (
          <div key={p.publication_id} className="text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-fg">
                {p.publication_name ?? p.publication_id}
              </span>
              {p.volume_confounded ? (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-subtle"
                  title="Sending materially more than it was. New subscribers open less, so part of this decline is arithmetic rather than a deliverability problem — ranked lower for that reason."
                >
                  sending {p.volume_ratio}x more — partly dilution
                </span>
              ) : null}
              {p.mix_confounded ? (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-subtle"
                  title="Most of this move is which newsletter lists they mailed, not any one list performing worse — often a list that stopped sending or a new one starting. Expand the lists below to see which. Ranked lower for that reason."
                >
                  mostly a list-mix change
                </span>
              ) : null}
            </div>
            <ul className="mt-0.5 space-y-1">
              {p.metrics.map((m) => (
                <li key={m.metric} className="text-muted tabular-nums">
                  <div>
                    {METRIC_LABELS[m.metric] ?? m.metric}:{" "}
                    <span className="text-fg">
                      {/* Each number carries the dates that produced
                          it. "42.1% → 31.3%" with no window is the
                          exact ambiguity this panel used to have. */}
                      <span
                        title={
                          windows?.baseline
                            ? `Baseline window: ${dateRange(windows.baseline)}`
                            : undefined
                        }
                      >
                        {pct(m.baseline, m.metric)}
                      </span>{" "}
                      →{" "}
                      <span
                        title={
                          windows?.recent
                            ? `Recent window: ${dateRange(windows.recent)}`
                            : undefined
                        }
                      >
                        {pct(m.recent, m.metric)}
                      </span>
                    </span>{" "}
                    ({pts(m.delta, m.metric)}
                    {/* Always show the cohort move next to the delta. A
                        bare "-11pt" invites the question "compared to
                        what?", and the honest answer is "the typical
                        newsletter moved this much". */}
                    , cohort {pts(m.cohort_delta, m.metric)})
                    {m.weeks_to_threshold != null ? (
                      <span className="text-fg">
                        {" "}
                        · ~{m.weeks_to_threshold}w to alerting
                      </span>
                    ) : null}
                  </div>
                  {/* The peak and the trough, dated. Two numbers and an
                      arrow cannot say whether this was a cliff in one
                      week or a slide across three months. */}
                  {m.high && m.low ? (
                    <div className="pl-3 text-subtle">
                      high {pct(m.high.value, m.metric)} wk of{" "}
                      {shortDate(m.high.week_start)} · low{" "}
                      {pct(m.low.value, m.metric)} wk of{" "}
                      {shortDate(m.low.week_start)}
                    </div>
                  ) : null}
                  {/* Only when the mix actually moved the number. On
                      most publications it shifts it by hundredths of a
                      point and printing that every time would train
                      people to skip the line that matters. */}
                  {m.mix_adjusted_delta != null &&
                  m.mix_delta != null &&
                  Math.abs(m.mix_delta) >= 0.005 ? (
                    <div className="pl-3 text-subtle">
                      within-list {pts(m.mix_adjusted_delta, m.metric)} — the
                      other {pts(m.mix_delta, m.metric)} is a change in which
                      lists they mailed
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <ListBreakdown lists={p.lists ?? []} />
          </div>
        ))}
        {hidden > 0 ? (
          <button
            onClick={() => setShowAll(true)}
            className="text-xs text-accent hover:underline"
          >
            Show {hidden} more {hidden === 1 ? "newsletter" : "newsletters"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
