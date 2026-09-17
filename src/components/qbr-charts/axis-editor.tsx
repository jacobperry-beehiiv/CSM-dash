"use client";

import { useEffect, useRef, useState } from "react";
import type { ChartSpec } from "@/lib/qbr-charts/types";
import {
  chartColumns,
  supportsAxisEditor,
  type AxisOverride,
} from "@/lib/qbr-charts/axis-override";

/**
 * Small popover that lets a CSM swap the X or Y axis on a QBR
 * chart before exporting. Columns come from the spec's own data —
 * whatever Metabase returned is what's on offer.
 *
 * Renders as a pencil button that opens a floating panel. The panel
 * uses vanilla `<select>` elements so we don't need to wire up
 * accessibility semantics for a custom dropdown; the pencil trigger
 * carries the aria-expanded relationship.
 *
 * No editor is shown for chart types that don't have X/Y axes
 * (scalar, pie, donut, table) — supportsAxisEditor() gates the
 * whole component.
 */
interface Props {
  spec: ChartSpec;
  override: AxisOverride | undefined;
  onChange: (next: AxisOverride | undefined) => void;
}

export function AxisEditor({ spec, override, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click. Matches the popover pattern used by
  // ColumnPicker / RowActions elsewhere in the app — a stopPropagation
  // inside the panel keeps clicks on the selects from closing it.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!supportsAxisEditor(spec)) return null;

  const columns = chartColumns(spec);
  const currentX = override?.xKey ?? spec.xKey ?? columns[0] ?? "";
  const currentY =
    override?.ySeriesKeys?.[0] ?? spec.series[0]?.key ?? columns[1] ?? "";
  const isOverridden = !!(override?.xKey || override?.ySeriesKeys?.length);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Edit chart axes"
        title={
          isOverridden
            ? "Axes reselected — click to adjust or reset"
            : "Reselect chart axes"
        }
        className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border transition-colors ${
          isOverridden
            ? "border-accent text-accent bg-accent/10 hover:bg-accent/15"
            : "border-border-strong text-muted bg-surface hover:bg-canvas/40"
        }`}
      >
        <span aria-hidden>✎</span>
        <span>Axes</span>
        {isOverridden ? <span className="text-[9px]">·edited</span> : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-1 z-20 w-64 rounded-md border border-border bg-surface shadow-lg p-3 text-xs">
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-border/60">
            <div className="font-semibold text-fg">Chart axes</div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted hover:text-fg text-[10px]"
            >
              close
            </button>
          </div>
          <label className="block mb-2">
            <span className="text-[10px] text-muted uppercase tracking-wide">
              X axis
            </span>
            <select
              value={currentX}
              onChange={(e) => {
                const next = e.target.value;
                onChange({
                  xKey: next === spec.xKey ? undefined : next,
                  ySeriesKeys: override?.ySeriesKeys,
                });
              }}
              className="mt-1 w-full px-2 py-1 border border-border-strong rounded-md bg-surface text-fg"
            >
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block mb-2">
            <span className="text-[10px] text-muted uppercase tracking-wide">
              Y axis (primary series)
            </span>
            <select
              value={currentY}
              onChange={(e) => {
                const next = e.target.value;
                const originalPrimary = spec.series[0]?.key;
                onChange({
                  xKey: override?.xKey,
                  ySeriesKeys:
                    next === originalPrimary ? undefined : [next],
                });
              }}
              className="mt-1 w-full px-2 py-1 border border-border-strong rounded-md bg-surface text-fg"
            >
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          {isOverridden ? (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="w-full mt-1 px-2 py-1 text-[11px] rounded-md border border-border-strong text-muted bg-surface hover:bg-canvas/40"
            >
              Reset to preset defaults
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
