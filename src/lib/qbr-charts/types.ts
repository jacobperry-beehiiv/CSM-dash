/**
 * QBR Charts — shared type surface.
 *
 * A ChartSpec is the lingua franca between the API and the renderer:
 * the API resolves a preset (or free-text prompt) to one of these
 * objects, the renderer hands it to <ChartCanvas /> which maps to
 * the right Recharts component. PR A only renders specs produced by
 * `heuristicSpec()` against the 17 QBR presets; PR B layers Claude
 * on top to refine titles + takeaways.
 *
 * Types live here so both server (API routes) and client (chart
 * components) can import without dragging server-only modules.
 */

export type ChartType =
  | "line"
  | "bar"
  | "stacked-bar"
  | "area"
  | "stacked-area"
  | "pie"
  | "donut"
  | "combo"
  | "scalar"
  | "table"
  | "scatter";

/** Formatting hint for one numeric series. Affects axis labels +
 *  tooltip rendering + scalar display. */
export type SeriesFormat = "number" | "percent" | "currency" | "date";

export interface SeriesConfig {
  /** Object key on each row that this series reads from. */
  key: string;
  /** Display label in legends + tooltips. */
  label: string;
  /** For combo charts only — which subtype to render this series as.
   *  Ignored on non-combo chart types. */
  variant?: "line" | "bar" | "area";
  /** Formatting for axis values + tooltip. Defaults to "number". */
  format?: SeriesFormat;
}

/** Recharts-friendly data row shape. Values are unknown because we
 *  receive whatever Metabase returns; the format hint on the series
 *  drives how it's rendered. */
export type ChartDatum = Record<string, unknown>;

export interface ChartSpec {
  title: string;
  subtitle?: string;
  chartType: ChartType;
  /** Object key on each row for the X axis. Required for line/bar/
   *  area/combo/scatter; ignored for scalar/pie/donut/table. */
  xKey?: string;
  xLabel?: string;
  yLabel?: string;
  series: SeriesConfig[];
  data: ChartDatum[];
  /** Provenance — "Metabase question 1849 · QBR Dashboard 694". */
  source?: string;
  /** One-line interpretation written by Claude (PR B) or left blank. */
  takeaway?: string;
}

/** Metadata describing one of the 17 QBR Dashboard 694 presets. The
 *  SQL itself lives in Metabase — we keep zero query duplication
 *  here. tags drive the heuristic-fallback prompt matcher; Claude
 *  reads them too in PR B. */
export interface QbrPreset {
  questionId: number;
  name: string;
  defaultChartType: ChartType;
  blurb: string;
  tags: string[];
}

/** Metabase column shape as returned by /api/dataset and
 *  /api/card/:id/query. The `name` is the column id we key rows by;
 *  `display_name` is the human label. `base_type` lets us pick a
 *  default series format (numeric → number, percent suffix → percent). */
export interface MetabaseColumn {
  name: string;
  display_name?: string;
  base_type?: string;
  effective_type?: string;
  /** Some Metabase responses carry `semantic_type` like
   *  "type/Percentage" — used as a stronger format hint. */
  semantic_type?: string;
}

/** What runCard() returns. Rows are already shaped as objects keyed
 *  by column name (consistent with runSavedQuestion's return shape). */
export interface RunCardResult {
  questionId: number;
  questionName: string;
  columns: MetabaseColumn[];
  rows: ChartDatum[];
}

/** Context every runCard call uses. organizationId is required for
 *  the QBR presets (every one of them filters on it); publicationId
 *  is optional and activates publication-mode. */
export interface RunCardContext {
  organizationId?: string;
  publicationId?: string;
  startMonth?: string;
  endMonth?: string;
  /** User-supplied values for params that aren't in our standard
   *  map (e.g. tier_id, sender_email). Filled in via the
   *  ExtraParams UI in PR C. */
  extras?: Record<string, string>;
}
