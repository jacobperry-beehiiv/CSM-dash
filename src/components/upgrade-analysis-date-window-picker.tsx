"use client";

import { useEffect, useState } from "react";
import type { AnalysisWindow } from "@/lib/engines/upgrade-analysis/types";

/**
 * Analysis window picker for the D&C Upgrade Analysis panel.
 *
 * Four presets (7 / 30 / 60 / 90 days) + a "Custom" mode that reveals
 * start/end date inputs. The presets fire `onChange` immediately —
 * a click on "Last 7 days" should re-scope the panel without a
 * separate Apply. Custom mode holds its edits until the user clicks
 * Apply because half-typed dates would otherwise thrash the endpoint.
 *
 * The `value` prop is the canonical picker state. When it's `null`
 * we default the visible state to "Last 30 days" (matching the
 * config default) rather than an empty control.
 */

interface Props {
  value: AnalysisWindow | null;
  onChange: (window: AnalysisWindow | null) => void;
  disabled?: boolean;
}

const PRESETS: Array<{ days: number; label: string }> = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 60, label: "Last 60 days" },
  { days: 90, label: "Last 90 days" },
];

type Mode = "preset" | "custom";

function todayYMD(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgoYMD(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function UpgradeAnalysisDateWindowPicker({
  value,
  onChange,
  disabled = false,
}: Props) {
  // Derive the visible mode from `value`. Range shape → custom mode.
  // Everything else (lookback presets + null "config default") → preset.
  const derivedMode: Mode = value?.kind === "range" ? "custom" : "preset";
  const [mode, setMode] = useState<Mode>(derivedMode);
  const [customStart, setCustomStart] = useState<string>(
    value?.kind === "range" ? value.start_date : daysAgoYMD(30)
  );
  const [customEnd, setCustomEnd] = useState<string>(
    value?.kind === "range" ? value.end_date : todayYMD()
  );

  // Keep the visible mode in sync if the parent flips the value
  // externally (e.g., after a saved cached scan reveals its window).
  useEffect(() => {
    setMode(derivedMode);
  }, [derivedMode]);

  const activePresetDays =
    value?.kind === "lookback" ? value.lookback_days : mode === "preset" ? 30 : null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {PRESETS.map((p) => {
        const active = mode === "preset" && activePresetDays === p.days;
        return (
          <button
            key={p.days}
            type="button"
            disabled={disabled}
            onClick={() => {
              setMode("preset");
              onChange({ kind: "lookback", lookback_days: p.days });
            }}
            className={`text-xs px-2 py-1 rounded border ${
              active
                ? "border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                : "border-border bg-surface hover:bg-surface-2 text-fg"
            } disabled:opacity-50`}
          >
            {p.label}
          </button>
        );
      })}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setMode("custom")}
        className={`text-xs px-2 py-1 rounded border ${
          mode === "custom"
            ? "border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
            : "border-border bg-surface hover:bg-surface-2 text-fg"
        } disabled:opacity-50`}
      >
        Custom
      </button>

      {mode === "custom" ? (
        <div className="flex items-center gap-1.5 ml-1">
          <input
            type="date"
            value={customStart}
            disabled={disabled}
            max={customEnd || undefined}
            onChange={(e) => setCustomStart(e.target.value)}
            className="text-xs px-1.5 py-0.5 rounded border border-border bg-surface disabled:opacity-50"
          />
          <span className="text-xs text-muted">→</span>
          <input
            type="date"
            value={customEnd}
            disabled={disabled}
            min={customStart || undefined}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="text-xs px-1.5 py-0.5 rounded border border-border bg-surface disabled:opacity-50"
          />
          <button
            type="button"
            disabled={disabled || !customStart || !customEnd || customStart > customEnd}
            onClick={() =>
              onChange({
                kind: "range",
                start_date: customStart,
                end_date: customEnd,
              })
            }
            className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}
