"use client";

import { formatValue, formatXAxis } from "@/lib/qbr-charts/format";
import type { SeriesConfig } from "@/lib/qbr-charts/types";

/**
 * Branded hover tooltip — small purple-accented card showing the X
 * label + one colored row per series. Reads each series's format
 * hint from `series` so a percent series renders "45.6%" while a
 * currency series next to it renders "$1.2K".
 *
 * Recharts' `Tooltip` `content` prop receives loose-typed props that
 * vary across chart types. Rather than depend on the library's
 * internal types (which moved between major versions), we declare
 * the exact shape we read.
 */
interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | string | null;
  color?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  label?: unknown;
  payload?: TooltipPayloadEntry[];
  series: SeriesConfig[];
}

export function ChartTooltip(props: ChartTooltipProps) {
  const { active, payload, label, series } = props;
  if (!active || !payload || payload.length === 0) return null;
  const seriesByKey = new Map(series.map((s) => [s.key, s]));
  return (
    <div className="rounded-md border border-border bg-surface shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-fg mb-1">{formatXAxis(label)}</div>
      <ul className="space-y-0.5">
        {payload.map((p, i) => {
          const cfg = seriesByKey.get(String(p.dataKey ?? ""));
          return (
            <li key={i} className="flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: p.color ?? "currentColor" }}
              />
              <span className="text-muted">
                {cfg?.label ?? String(p.dataKey ?? "")}
              </span>
              <span className="ml-auto font-mono font-medium text-fg">
                {formatValue(p.value, cfg?.format)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
