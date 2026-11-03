"use client";

import { useState } from "react";

/**
 * The red-row warning for a workspace whose engagement is degrading
 * while still inside the deliverability thresholds.
 *
 * Two pieces live here: the hook that fetches the report once for the
 * whole table, and the panel rendered inside an expanded row. The
 * fetch is shared because the customer table renders up to ~600 rows
 * and each one needs an O(1) lookup, not its own request.
 */

export interface TrendMetricRow {
  metric: string;
  recent: number;
  baseline: number;
  delta: number;
  cohort_delta: number;
  weeks_to_threshold: number | null;
  severity: number;
}

export interface TrendPublicationRow {
  publication_id: string;
  publication_name: string | null;
  severity: number;
  volume_ratio: number;
  volume_confounded: boolean;
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

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pts(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;
}

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

export function TrendWarningPanel({ row, onChange }: Props) {
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
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {p.metrics.map((m) => (
                <li key={m.metric} className="text-muted tabular-nums">
                  {METRIC_LABELS[m.metric] ?? m.metric}:{" "}
                  <span className="text-fg">
                    {pct(m.baseline)} → {pct(m.recent)}
                  </span>{" "}
                  ({pts(m.delta)}
                  {/* Always show the cohort move next to the delta. A
                      bare "-11pt" invites the question "compared to
                      what?", and the honest answer is "the typical
                      newsletter moved this much". */}
                  , cohort {pts(m.cohort_delta)})
                  {m.weeks_to_threshold != null ? (
                    <span className="text-fg">
                      {" "}
                      · ~{m.weeks_to_threshold}w to alerting
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
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
