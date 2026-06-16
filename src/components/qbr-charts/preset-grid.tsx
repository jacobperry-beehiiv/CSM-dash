"use client";

import { QBR_PRESETS } from "@/lib/qbr-charts/qbr-presets";
import type { QbrPreset } from "@/lib/qbr-charts/types";

/**
 * Grid of the 17 QBR Dashboard 694 presets. Each tile shows the
 * question name, the default chart-type badge, and a one-line
 * blurb. Tiles are disabled until a workspace ID is filled (the
 * Controls component enforces this) so a click can't fire with
 * missing context.
 */
export function PresetGrid({
  disabled,
  onPick,
  loadingQuestionId,
}: {
  disabled: boolean;
  onPick: (preset: QbrPreset) => void;
  loadingQuestionId: number | null;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-fg">QBR Dashboard 694</h3>
        <span className="text-[11px] text-muted">
          {QBR_PRESETS.length} preset charts
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {QBR_PRESETS.map((p) => {
          const loading = loadingQuestionId === p.questionId;
          return (
            <button
              key={p.questionId}
              type="button"
              disabled={disabled || loading}
              onClick={() => onPick(p)}
              className="text-left p-3 rounded-md border border-border bg-surface hover:bg-canvas/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-sm font-medium text-fg truncate">
                  {p.name}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">
                  {p.defaultChartType}
                </span>
              </div>
              <p className="text-xs text-muted line-clamp-2">{p.blurb}</p>
              {loading ? (
                <p className="mt-1 text-[11px] text-accent">Loading…</p>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
