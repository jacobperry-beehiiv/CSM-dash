import type {
  ChartDatum,
  ChartSpec,
  ChartType,
  MetabaseColumn,
  QbrPreset,
  SeriesConfig,
  SeriesFormat,
} from "./types";
import { getPreset, QBR_PRESETS } from "./qbr-presets";

/**
 * Build a ChartSpec from raw Metabase output without Claude. Used:
 *   - Always in PR A (we don't have the Anthropic SDK yet).
 *   - As fallback in PR B when Claude errors or times out.
 *
 * Rules:
 *   - X-key   = first date-like or string column.
 *   - Series  = every remaining numeric column.
 *   - Format  = inferred from column name (% → percent, $/usd →
 *               currency, ISO date → date) or base_type.
 *   - Title   = preset.name when present, else questionName.
 *   - Type    = preferredChartType when explicit, else
 *               preset.defaultChartType, else "line".
 *
 * Deliberately conservative — if a column doesn't match a known
 * shape, we treat it as a generic number rather than guessing
 * wrong.
 */
export function heuristicSpec(input: {
  preferredChartType: ChartType | "auto";
  questionId: number;
  questionName: string;
  columns: MetabaseColumn[];
  rows: ChartDatum[];
}): ChartSpec {
  const preset = getPreset(input.questionId);
  const chartType: ChartType =
    input.preferredChartType !== "auto"
      ? input.preferredChartType
      : preset?.defaultChartType ?? "line";

  // Pick an X column — first date-like, else first non-numeric.
  const xColumn = pickXColumn(input.columns);
  const xKey = xColumn?.name;

  // Series = every numeric column that isn't the X column. For
  // scalar charts we only need one numeric — Recharts ignores the
  // rest. For pie/donut/table the canvas reads the spec slightly
  // differently (label + value).
  const numericColumns = input.columns.filter(
    (c) => c.name !== xKey && isNumericColumn(c)
  );
  const series: SeriesConfig[] = numericColumns.map((c) => ({
    key: c.name,
    label: humanizeColumnName(c),
    format: inferFormat(c),
  }));

  // Combo charts need at least one bar + one line series, so split
  // by name heuristic: the first numeric goes to "bar", the rest to
  // "line". Hayden's reference impl uses this convention for
  // subscriber-growth (bar = monthly adds, line = cumulative).
  if (chartType === "combo" && series.length > 1) {
    series[0].variant = "bar";
    for (let i = 1; i < series.length; i++) series[i].variant = "line";
  }

  const title = preset?.name ?? input.questionName;
  const subtitle = preset?.blurb;

  return {
    title,
    subtitle,
    chartType,
    xKey,
    xLabel: xColumn ? humanizeColumnName(xColumn) : undefined,
    series,
    data: input.rows,
    source: `Metabase question ${input.questionId}${preset ? " · QBR Dashboard 694" : ""}`,
  };
}

/**
 * Match a free-text prompt against the 17 presets using tag overlap.
 * Used as Claude's fallback (PR B). Lowercase + word-token compare;
 * highest tag-hit count wins. Returns null when no preset's tags
 * overlap the prompt at all so the caller can surface
 * "no preset match" cleanly instead of forcing a bad guess.
 */
export function tagMatch(prompt: string): QbrPreset | null {
  const lowered = prompt.toLowerCase();
  let best: { preset: QbrPreset; score: number } | null = null;
  for (const preset of QBR_PRESETS) {
    let score = 0;
    for (const tag of preset.tags) {
      if (lowered.includes(tag.toLowerCase())) score += 1;
    }
    // Name match is a strong signal — boost it.
    if (lowered.includes(preset.name.toLowerCase())) score += 3;
    if (score > 0 && (!best || score > best.score)) {
      best = { preset, score };
    }
  }
  return best?.preset ?? null;
}

// ─── Column heuristics ────────────────────────────────────────────────

function pickXColumn(columns: MetabaseColumn[]): MetabaseColumn | undefined {
  // Prefer explicit date types.
  const dateCol = columns.find((c) => isDateColumn(c));
  if (dateCol) return dateCol;
  // Else first non-numeric column (likely a category label).
  const stringCol = columns.find((c) => !isNumericColumn(c));
  if (stringCol) return stringCol;
  // Last resort: first column.
  return columns[0];
}

function isDateColumn(c: MetabaseColumn): boolean {
  const t = (c.effective_type ?? c.base_type ?? "").toLowerCase();
  if (t.includes("date") || t.includes("datetime") || t.includes("time")) {
    return true;
  }
  // Name-based fallback (month, week, date suffix).
  const n = c.name.toLowerCase();
  return /(month|week|date|day|period)$/.test(n) || /^month\b/.test(n);
}

function isNumericColumn(c: MetabaseColumn): boolean {
  const t = (c.effective_type ?? c.base_type ?? "").toLowerCase();
  return (
    t.includes("integer") ||
    t.includes("decimal") ||
    t.includes("number") ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("bigint")
  );
}

function inferFormat(c: MetabaseColumn): SeriesFormat {
  const sem = (c.semantic_type ?? "").toLowerCase();
  if (sem.includes("percent") || sem.includes("ratio")) return "percent";
  if (sem.includes("currency") || sem.includes("money")) return "currency";
  const n = c.name.toLowerCase();
  if (
    n.includes("rate") ||
    n.includes("pct") ||
    n.includes("percent") ||
    n.endsWith("_ratio")
  ) {
    return "percent";
  }
  if (
    n.includes("earnings") ||
    n.includes("revenue") ||
    n.includes("mrr") ||
    n.includes("arr") ||
    n.startsWith("$") ||
    n.endsWith("_usd")
  ) {
    return "currency";
  }
  return "number";
}

function humanizeColumnName(c: MetabaseColumn): string {
  if (c.display_name) return c.display_name;
  // Snake_case → Title Case.
  return c.name
    .split(/[_\s]+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
