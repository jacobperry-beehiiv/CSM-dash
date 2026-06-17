/**
 * Display formatters for QBR Charts. Pure functions, no React — so
 * server-side spec generation (Claude's takeaway + the API's source
 * line) and client-side renderers can share them.
 */

import type { SeriesFormat } from "./types";

/** Format one value per its series's format hint. Falls back to the
 *  raw string repr when the format is unknown or the value isn't
 *  numeric. */
export function formatValue(value: unknown, format?: SeriesFormat): string {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "date") return formatXAxis(value);
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  switch (format) {
    case "percent": {
      // Metabase returns percentages either as 0–1 ratios or 0–100
      // integers depending on the question. >2 means it's the
      // already-multiplied form; <=2 means it's a ratio.
      const pct = n > 2 ? n : n * 100;
      const abs = Math.abs(pct);
      // Auto-precision: spam/complaint rates land in the 0.001-0.5%
      // band and round to "0.0%" at 1 decimal — useless. Bucket the
      // decimals to the magnitude so we keep ~2 significant figures
      // for small values without breaking the "47.5%" open-rate look
      // at the high end.
      const decimals =
        abs === 0 ? 1 : abs < 0.01 ? 4 : abs < 0.1 ? 3 : abs < 1 ? 2 : 1;
      return `${pct.toFixed(decimals)}%`;
    }
    case "currency":
      // Compact form for axis ticks ($1.2K) so labels don't crowd.
      // Tooltip uses full form via formatValue's twin in chart-tooltip.
      return Math.abs(n) >= 1_000
        ? `$${compactNumber(n)}`
        : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    case "number":
    default:
      return Math.abs(n) >= 10_000
        ? compactNumber(n)
        : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}

/**
 * Format a value for the X-axis. ISO date strings ("2026-01-01" or
 * "2026-01-01T00:00:00Z") render as "Jan '26"; non-dates pass
 * through. The "'YY" suffix is short on purpose — QBR charts span
 * 12+ months and full years would overlap.
 */
export function formatXAxis(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // ISO date heuristic: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS prefix.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    const month = d.toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
    return `${month} '${yy}`;
  }
  return s;
}

/**
 * Compact a number to K/M/B form. 12500 → "12.5K", 1_500_000 → "1.5M",
 * 1_234_567_890 → "1.23B". One decimal for K/M; two for B so very-
 * large numbers don't lose precision in axis labels.
 */
export function compactNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value ?? "");
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
