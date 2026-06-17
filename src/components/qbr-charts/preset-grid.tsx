"use client";

import { QBR_PRESETS } from "@/lib/qbr-charts/qbr-presets";
import type { QbrPreset } from "@/lib/qbr-charts/types";

export type TileStatus = "idle" | "loading" | "ready" | "error";

export interface TileState {
  status: TileStatus;
  /** Populated when status === "error". Shown in the tile and reused
   *  by the retry handler. */
  error?: string;
  /** Populated when status === "ready". False when specHasData()
   *  classified the result as empty / all-zero / all-null. The tile
   *  greys out and the deck-builder excludes it by default. */
  hasData?: boolean;
  /** Whether this tile is currently included in the deck. Only
   *  meaningful when status === "ready". Defaults to true for
   *  hasData tiles, false for no-data tiles. */
  inDeck?: boolean;
}

/**
 * Grid of QBR Dashboard 694 presets. The orchestrator (QbrChartsTab)
 * runs a sequential pre-warm — each tile flips through
 * idle → loading → ready (or → error) as its query lands. A "ready"
 * tile is clickable and reveals the chart from cached spec; a
 * "loading" tile is disabled so the user can't double-fire; an
 * "error" tile is clickable and retries that single chart.
 */
export function PresetGrid({
  disabled,
  onPick,
  states,
}: {
  disabled: boolean;
  onPick: (preset: QbrPreset) => void;
  states: Record<number, TileState>;
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
          const state = states[p.questionId] ?? { status: "idle" };
          const isLoading = state.status === "loading";
          const isReady = state.status === "ready";
          const isError = state.status === "error";
          const isIdle = state.status === "idle";
          const noData = isReady && state.hasData === false;
          const inDeck = isReady && state.inDeck === true;
          const clickable = !disabled && !isLoading && !isIdle;
          return (
            <button
              key={p.questionId}
              type="button"
              disabled={!clickable}
              onClick={() => onPick(p)}
              className={[
                "text-left p-3 rounded-md border transition-colors",
                noData
                  ? "border-border bg-surface opacity-50 hover:opacity-70 cursor-pointer"
                  : isReady
                    ? "border-accent/40 bg-surface hover:bg-canvas/40 cursor-pointer"
                    : isError
                      ? "border-red-300 dark:border-red-700 bg-red-50/40 dark:bg-red-500/5 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer"
                      : isLoading
                        ? "border-border bg-surface cursor-wait"
                        : "border-border bg-surface opacity-60 cursor-not-allowed",
              ].join(" ")}
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
              <div className="mt-1 text-[11px] flex items-center gap-2 flex-wrap">
                {isLoading ? (
                  <span className="text-accent inline-flex items-center gap-1">
                    <Spinner /> Loading…
                  </span>
                ) : noData ? (
                  <>
                    <span className="text-muted">No data</span>
                    <span className="text-subtle">· click to inspect</span>
                  </>
                ) : isReady ? (
                  <>
                    <span className="text-emerald-700 dark:text-emerald-400">
                      Ready · click to view
                    </span>
                    {inDeck ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">
                        In deck
                      </span>
                    ) : null}
                  </>
                ) : isError ? (
                  <span
                    className="text-red-700 dark:text-red-300 truncate block"
                    title={state.error}
                  >
                    {state.error ?? "Failed"} · click to retry
                  </span>
                ) : (
                  <span className="text-subtle">Idle</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 rounded-full border-2 border-accent border-r-transparent animate-spin"
    />
  );
}
