"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pickColor, beehiiv } from "@/lib/qbr-charts/colors";
import {
  compactNumber,
  formatValue,
  formatXAxis,
} from "@/lib/qbr-charts/format";
import type { ChartSpec, SeriesConfig } from "@/lib/qbr-charts/types";
import { ChartTooltip } from "./chart-tooltip";

/**
 * The dispatch table for ChartSpec → Recharts component. Fixed
 * 460px chart height (per Hayden's spec) so screenshots are
 * consistent across slide decks.
 *
 * One file does all chart types — keeps shared theming
 * (axis-styling, color palette, tooltip) in one place. Each branch
 * unwraps the spec into the relevant Recharts component:
 *
 *   • line / bar / stacked-bar / area / stacked-area / combo →
 *     time-series-style chart with shared X + multiple series.
 *   • pie / donut → first series treated as label, second as value.
 *   • scalar     → big-number card; no Recharts, just typography.
 *   • table      → simple HTML table for the acquisition-source
 *                  ranks; not a chart but Metabase's TABLE display
 *                  type maps here.
 *   • scatter    → X = first numeric, Y = second numeric.
 *
 * Falls back to "line" for unknown chart types to keep the surface
 * resilient when Claude (PR B) suggests something we don't render.
 */
export function ChartCanvas({ spec }: { spec: ChartSpec }) {
  if (spec.data.length === 0) {
    return (
      <div className="h-[460px] flex items-center justify-center text-sm text-muted">
        No data for this period.
      </div>
    );
  }

  if (spec.chartType === "scalar") return <ScalarCard spec={spec} />;
  if (spec.chartType === "table") return <TableCard spec={spec} />;
  if (spec.chartType === "pie" || spec.chartType === "donut") {
    return <PieCard spec={spec} />;
  }
  if (spec.chartType === "scatter") return <ScatterCard spec={spec} />;

  return <CartesianCard spec={spec} />;
}

// ─── Axis + grid theme ────────────────────────────────────────────────

const axisProps = {
  stroke: beehiiv.muted,
  tick: { fill: beehiiv.muted, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: beehiiv.line },
} as const;

const gridProps = {
  stroke: beehiiv.line,
  strokeDasharray: "3 3",
  vertical: false,
} as const;

// ─── Cartesian (line / bar / area / combo / stacked) ──────────────────

function CartesianCard({ spec }: { spec: ChartSpec }) {
  const { chartType, xKey, series, data } = spec;
  if (!xKey || series.length === 0) {
    return (
      <div className="h-[460px] flex items-center justify-center text-sm text-muted">
        Chart spec missing X axis or series.
      </div>
    );
  }

  const stacked = chartType === "stacked-bar" || chartType === "stacked-area";
  const yFormat = pickPredominantYFormat(series);

  // Combo is its own component; the others share LineChart/BarChart/
  // AreaChart. Compose via ComposedChart for combo so a single chart
  // can mix bar + line in one render pass.
  if (chartType === "combo") {
    return (
      <ResponsiveContainer width="100%" height={460}>
        <ComposedChart
          data={data}
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
        >
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={formatXAxis} />
          <YAxis {...axisProps} tickFormatter={(v) => compactNumber(v)} />
          <Tooltip content={<ChartTooltip series={series} />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {series.map((s, i) => {
            const color = pickColor(i);
            if (s.variant === "bar") {
              return (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  fill={color}
                  radius={[2, 2, 0, 0]}
                />
              );
            }
            if (s.variant === "area") {
              return (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  fill={color}
                  fillOpacity={0.2}
                  stroke={color}
                  strokeWidth={2}
                />
              );
            }
            return (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={color}
                strokeWidth={2}
                dot={false}
              />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "bar" || chartType === "stacked-bar") {
    return (
      <ResponsiveContainer width="100%" height={460}>
        <BarChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={formatXAxis} />
          <YAxis
            {...axisProps}
            tickFormatter={(v) =>
              yFormat === "percent" ? `${Number(v).toFixed(0)}%` : compactNumber(v)
            }
          />
          <Tooltip content={<ChartTooltip series={series} />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={pickColor(i)}
              stackId={stacked ? "x" : undefined}
              radius={[2, 2, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "area" || chartType === "stacked-area") {
    return (
      <ResponsiveContainer width="100%" height={460}>
        <AreaChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={formatXAxis} />
          <YAxis
            {...axisProps}
            tickFormatter={(v) =>
              yFormat === "percent" ? `${Number(v).toFixed(0)}%` : compactNumber(v)
            }
          />
          <Tooltip content={<ChartTooltip series={series} />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {series.map((s, i) => {
            const color = pickColor(i);
            return (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={color}
                fill={color}
                fillOpacity={0.2}
                strokeWidth={2}
                stackId={stacked ? "x" : undefined}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // line (default).
  return (
    <ResponsiveContainer width="100%" height={460}>
      <LineChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey={xKey} {...axisProps} tickFormatter={formatXAxis} />
        <YAxis
          {...axisProps}
          tickFormatter={(v) =>
            yFormat === "percent" ? `${Number(v).toFixed(0)}%` : compactNumber(v)
          }
        />
        <Tooltip content={<ChartTooltip series={series} />} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {series.map((s, i) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stroke={pickColor(i)}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── Scalar (single-number) card ──────────────────────────────────────

function ScalarCard({ spec }: { spec: ChartSpec }) {
  const series = spec.series[0];
  const row = spec.data[0];
  const raw = series && row ? row[series.key] : null;
  return (
    <div className="h-[460px] flex flex-col items-center justify-center gap-3">
      <div
        className="text-7xl font-semibold tracking-tight"
        style={{ color: beehiiv.purple }}
      >
        {formatValue(raw, series?.format)}
      </div>
      {series?.label ? (
        <div className="text-sm text-muted">{series.label}</div>
      ) : null}
    </div>
  );
}

// ─── Pie / donut ──────────────────────────────────────────────────────

function PieCard({ spec }: { spec: ChartSpec }) {
  // For pie: x-key = slice label, first numeric series = slice
  // value. Heuristic spec passes the rows verbatim.
  const labelKey = spec.xKey;
  const valueSeries = spec.series[0];
  if (!labelKey || !valueSeries) return null;
  return (
    <ResponsiveContainer width="100%" height={460}>
      <PieChart>
        <Tooltip content={<ChartTooltip series={spec.series} />} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Pie
          data={spec.data}
          dataKey={valueSeries.key}
          nameKey={labelKey}
          cx="50%"
          cy="50%"
          outerRadius={150}
          innerRadius={spec.chartType === "donut" ? 80 : 0}
          paddingAngle={2}
          label={(entry: unknown) => {
            const e = (entry ?? {}) as Record<string, unknown>;
            return formatValue(e[valueSeries.key], valueSeries.format);
          }}
        >
          {spec.data.map((_, i) => (
            <Cell key={i} fill={pickColor(i)} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── Scatter ──────────────────────────────────────────────────────────

function ScatterCard({ spec }: { spec: ChartSpec }) {
  const xKey = spec.xKey;
  const yKey = spec.series[0]?.key;
  if (!xKey || !yKey) return null;
  return (
    <ResponsiveContainer width="100%" height={460}>
      <ScatterChart margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis dataKey={yKey} {...axisProps} />
        <Tooltip content={<ChartTooltip series={spec.series} />} />
        <Scatter data={spec.data} fill={beehiiv.purple} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

// ─── Table ────────────────────────────────────────────────────────────

function TableCard({ spec }: { spec: ChartSpec }) {
  const headers: string[] = [];
  if (spec.xKey) headers.push(spec.xLabel ?? spec.xKey);
  for (const s of spec.series) headers.push(s.label);
  return (
    <div className="h-[460px] overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted border-b border-border">
            {headers.map((h) => (
              <th key={h} className="py-2 px-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.data.map((row, i) => (
            <tr key={i} className="border-b border-border/60">
              {spec.xKey ? (
                <td className="py-2 px-2 text-fg">
                  {formatXAxis(row[spec.xKey])}
                </td>
              ) : null}
              {spec.series.map((s) => (
                <td key={s.key} className="py-2 px-2 font-mono text-fg">
                  {formatValue(row[s.key], s.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function pickPredominantYFormat(
  series: SeriesConfig[]
): "percent" | "currency" | "number" {
  const counts = { percent: 0, currency: 0, number: 0 };
  for (const s of series) {
    if (s.format === "percent") counts.percent++;
    else if (s.format === "currency") counts.currency++;
    else counts.number++;
  }
  if (counts.percent > counts.number && counts.percent >= counts.currency) {
    return "percent";
  }
  if (counts.currency > counts.number) return "currency";
  return "number";
}
