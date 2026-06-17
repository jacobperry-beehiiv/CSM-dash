/**
 * "Does this chart have data worth showing?" — classifies a ChartSpec
 * as having usable data vs. empty (no rows / all zeros / all null).
 *
 * Why we need it: a workspace might query for a chart the publication
 * doesn't apply to (e.g. paid-subscriber growth on a free-only pub).
 * Metabase returns the SQL result honestly — usually a row per month
 * with zeros everywhere. Visually that's a flat line at zero, which
 * is technically truthful but worse than useless in a QBR deck. The
 * UI greys out these tiles and the deck-builder skips them entirely.
 *
 * Heuristic (in order of strictness):
 *
 *   1. No rows at all → no data.
 *   2. Scalar with null/0 value → no data.
 *   3. Multi-row: sum the absolute value of every numeric series
 *      cell across every row. If the total is 0, treat as no data.
 *      This catches all-zero series + all-null series in one pass.
 *
 * False positives we accept: a chart that legitimately reports "0
 * across the board" (e.g. zero churn in every month of the window)
 * gets flagged as no-data and skipped. That's fine — it's not
 * meaningful for a customer-facing deck.
 */

import type { ChartSpec } from "./types";

export function specHasData(spec: ChartSpec): boolean {
  if (!spec.data || spec.data.length === 0) return false;

  if (spec.chartType === "scalar") {
    const firstSeries = spec.series[0];
    if (!firstSeries) return false;
    const v = spec.data[0]?.[firstSeries.key];
    if (v === null || v === undefined) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) && n !== 0;
    }
    return true;
  }

  let total = 0;
  for (const row of spec.data) {
    for (const s of spec.series) {
      const v = row[s.key];
      if (v === null || v === undefined) continue;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) total += Math.abs(n);
    }
  }
  return total > 0;
}
