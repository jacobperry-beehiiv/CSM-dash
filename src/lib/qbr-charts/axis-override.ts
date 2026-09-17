import type { ChartSpec, SeriesConfig } from "./types";

/**
 * User-selected axis overrides for one QBR tile.
 *
 * The QBR pipeline picks X + Y column heuristics from the Metabase
 * result (see heuristic.ts); this override lets the CSM swap either
 * axis before exporting. Kept transient (per-session, tab-local) —
 * we don't persist overrides because the underlying query can
 * return a different column set on the next run.
 */
export interface AxisOverride {
  /** Object key to use as the X axis. Must exist in `spec.data[0]`. */
  xKey?: string;
  /** Object keys to render as Y series, in order. First entry wins
   *  the primary color; format hints inherit from the matching
   *  original series when the key was already in `spec.series`. */
  ySeriesKeys?: string[];
}

/** Cartesian chart types that support X + Y overrides. Scalar, pie,
 *  donut and table have different axis semantics — omit them here so
 *  the editor UI can gate render on this list. */
const CARTESIAN_TYPES = new Set([
  "line",
  "bar",
  "stacked-bar",
  "area",
  "stacked-area",
  "combo",
  "scatter",
]);

/** True when the chart type supports the X/Y axis editor. */
export function supportsAxisEditor(spec: ChartSpec): boolean {
  return CARTESIAN_TYPES.has(spec.chartType);
}

/** Enumerate the columns available on a spec's data, in first-row
 *  order. Falls back to whatever's in series when data is empty
 *  (guards against a no-data spec dropping the editor entirely). */
export function chartColumns(spec: ChartSpec): string[] {
  const first = spec.data[0];
  if (first) return Object.keys(first);
  // Fallback — cover the current xKey + series keys so the editor
  // can still reset to defaults after a no-data render.
  const out = new Set<string>();
  if (spec.xKey) out.add(spec.xKey);
  for (const s of spec.series) out.add(s.key);
  return [...out];
}

/** Apply an override to a spec, producing a new spec suitable for
 *  the renderer. Unset override fields fall through to the original
 *  spec. When a Y key was in the original series, we preserve its
 *  label + format; a brand-new key gets a title-cased label from
 *  the raw column name. */
export function applyAxisOverride(
  spec: ChartSpec,
  override: AxisOverride | undefined
): ChartSpec {
  if (!override || (!override.xKey && !override.ySeriesKeys?.length)) {
    return spec;
  }
  const nextXKey = override.xKey ?? spec.xKey;
  const nextSeries: SeriesConfig[] = override.ySeriesKeys?.length
    ? override.ySeriesKeys.map((key) => {
        const priorMatch = spec.series.find((s) => s.key === key);
        if (priorMatch) return priorMatch;
        return {
          key,
          label: humanizeKey(key),
          format: "number" as const,
        };
      })
    : spec.series;
  return {
    ...spec,
    xKey: nextXKey,
    series: nextSeries,
  };
}

/** Convert a snake_case / camelCase column name into a human label
 *  for series that weren't in the original spec. Matches the
 *  formatter conventions used elsewhere in the tab. */
function humanizeKey(key: string): string {
  const cleaned = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
