"use client";

import type {
  AnalysisWindow,
  DeliverabilitySnapshot,
  DeliverabilitySnapshotRow,
} from "@/lib/engines/upgrade-analysis/types";

/**
 * D&C-aligned Deliverability Snapshot tile. Mounts above the six
 * pillar cards on `UpgradeAnalysisPanel`. Renders the same 7-metric
 * table the deliverability-quick-screen and enterprise-upgrade-
 * prescreening skills use (see the Skill Logic Breakdown PDF for the
 * exact thresholds and formulas).
 *
 * Deliberately separate from pillar scoring: the pillar cards use
 * tunable thresholds tuned against `delivered` denominators, while
 * this tile uses D&C's fixed thresholds tuned against `sent` for
 * five of the seven ratios. Two surfaces, one source of truth
 * (`FunnelCounters` with `sent` + `unsubs` added).
 *
 * Renders four states:
 *   - `clean`      — normal grid, all rows green.
 *   - `flagged`    — normal grid, at least one row red.
 *   - `low_volume` — banner + raw counts; rates suppressed
 *                    (sent < 100 in the window makes rates noise).
 *   - `no_data`    — banner "NO SEND DATA".
 */

interface Props {
  snapshot: DeliverabilitySnapshot;
  /** The window this scan actually ran over. Used to render an
   *  explicit date range in the subheader when the CSM picked a
   *  Custom range; the preset lookbacks just show the day count. */
  analysisWindow?: AnalysisWindow | null;
}

function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatValue(row: DeliverabilitySnapshotRow): string {
  if (row.value == null) return "—";
  const digits = row.key === "spam_rate" ? 3 : row.key === "hard_bounce_rate" ? 3 : 2;
  return pct(row.value, digits);
}

function formatThreshold(row: DeliverabilitySnapshotRow): string {
  const digits = row.key === "spam_rate" ? 3 : 2;
  const value = pct(row.threshold, digits);
  if (row.key === "open_rate") return `< ${value}`;
  if (row.key === "delivery_rate") return `≤ ${value}`;
  return `≥ ${value}`;
}

export function UpgradeAnalysisSnapshotTile({
  snapshot,
  analysisWindow,
}: Props) {
  const { status, window_days, sent, delivered, rows, flagged_count } = snapshot;
  // Subheader: an explicit range wins over the day count so the CSM
  // sees exactly what they asked for; presets keep the "last N days"
  // phrasing.
  const windowText =
    analysisWindow?.kind === "range"
      ? `${analysisWindow.start_date} → ${analysisWindow.end_date}`
      : `last ${window_days} days`;

  const headerChip =
    status === "flagged" ? (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30">
        {flagged_count} of 7 flagged
      </span>
    ) : status === "clean" ? (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
        All 7 clean
      </span>
    ) : status === "low_volume" ? (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
        LOW VOLUME · {sent.toLocaleString()} sent
      </span>
    ) : (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-slate-500/10 text-slate-700 dark:text-slate-300 border border-slate-500/30">
        NO SEND DATA
      </span>
    );

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
            Deliverability snapshot
            {headerChip}
          </h3>
          <p className="text-xs text-muted mt-0.5">
            D&amp;C-standard 7-metric flag table over the{" "}
            <strong>{windowText}</strong>. Fixed thresholds — matches
            the deliverability-quick-screen and prescreening skills.
          </p>
        </div>
        <div className="text-[10px] text-subtle text-right whitespace-nowrap">
          {sent.toLocaleString()} sent · {delivered.toLocaleString()} delivered
        </div>
      </div>

      {status === "no_data" ? (
        <div className="mt-3 text-xs text-muted">
          The publication didn&apos;t send anything in this window. Widen
          the date range or verify the pub id.
        </div>
      ) : status === "low_volume" ? (
        <div className="mt-3 text-xs text-muted">
          Below <strong>100 sent</strong> in the window — rates are
          suppressed because a tiny denominator makes flag readings
          unreliable. Raw counts still shown above.
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-subtle border-b border-border/60">
                <th className="text-left font-medium py-1 pr-2">Metric</th>
                <th className="text-left font-medium py-1 pr-2">Formula</th>
                <th className="text-right font-medium py-1 pr-2">Value</th>
                <th className="text-right font-medium py-1 pr-2">Flag at</th>
                <th className="text-right font-medium py-1 w-14"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const flagCell =
                  row.flagged == null ? (
                    <span className="text-subtle">—</span>
                  ) : row.flagged ? (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30">
                      ✕
                    </span>
                  ) : (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                      ✓
                    </span>
                  );
                const valueTone =
                  row.flagged === true
                    ? "text-red-700 dark:text-red-300 font-semibold"
                    : row.flagged === false
                      ? "text-fg"
                      : "text-subtle";
                return (
                  <tr key={row.key} className="border-b border-border/40">
                    <td className="py-1.5 pr-2 text-fg">{row.label}</td>
                    <td className="py-1.5 pr-2 text-subtle font-mono text-[10px]">
                      {row.formula}
                    </td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${valueTone}`}>
                      {formatValue(row)}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-subtle tabular-nums">
                      {formatThreshold(row)}
                    </td>
                    <td className="py-1.5 text-right">{flagCell}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
