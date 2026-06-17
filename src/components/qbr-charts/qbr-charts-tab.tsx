"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartCard } from "./chart-card";
import { DeckPreview, type DeckSlide } from "./deck-preview";
import { PresetGrid, type TileState } from "./preset-grid";
import {
  WorkspacePicker,
  type WorkspaceOption,
} from "./workspace-picker";
import { PublicationPicker } from "./publication-picker";
import { QBR_PRESETS } from "@/lib/qbr-charts/qbr-presets";
import { specHasData } from "@/lib/qbr-charts/has-data";
import type {
  ChartSpec,
  ChartType,
  QbrPreset,
} from "@/lib/qbr-charts/types";

/**
 * QBR Charts tab orchestrator.
 *
 * Flow:
 *   1. CSM picks a workspace (defaults scoped to their book — admin
 *      can toggle "All workspaces").
 *   2. Optional: pick a publication (chained off the workspace).
 *   3. Optional: pick a date range / chart-type override.
 *   4. Click "Load charts". All 17 QBR presets are fetched
 *      sequentially. Each tile transitions idle → loading → ready
 *      (or → error) as its query lands.
 *   5. Click any ready tile to render the cached chart. Click an
 *      errored tile to retry just that one.
 *
 * Why sequential? Heavy QBR queries (multi-month subscriber growth,
 * open/CTR combos) can run 30-90s on a cold Metabase cache. Firing
 * 17 in parallel hammers Metabase and risks 504s; sequential keeps
 * the load gentle and lets early-finishing tiles become clickable
 * well before the full set is done.
 *
 * Cancellation: any input change (workspace, publication, dates,
 * chart-type override) aborts the in-flight queue, clears the
 * cached specs, and resets all tiles. The user re-clicks "Load
 * charts" to refresh.
 */
export function QbrChartsTab({
  workspaces,
  csm,
  isAdmin,
}: {
  workspaces: WorkspaceOption[];
  csm: string | null;
  isAdmin: boolean;
}) {
  const [organizationId, setOrganizationId] = useState("");
  const [publicationId, setPublicationId] = useState("");
  const [startMonth, setStartMonth] = useState("");
  const [endMonth, setEndMonth] = useState("");
  const [chartType, setChartType] = useState<ChartType | "auto">("auto");

  const [specs, setSpecs] = useState<Record<number, ChartSpec>>({});
  const [tileStates, setTileStates] = useState<Record<number, TileState>>({});
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(
    null
  );
  const [isRunning, setIsRunning] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [deckOpen, setDeckOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const canRun = organizationId.trim().length > 0;
  const hasResults = Object.keys(tileStates).length > 0;

  // Any input change invalidates cached specs + cancels any in-flight
  // run. Keeping a stale spec around would be a UX trap: clicking a
  // tile after switching workspaces would silently render the
  // previous workspace's chart.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSpecs({});
    setTileStates({});
    setSelectedQuestionId(null);
    setIsRunning(false);
    setGlobalError(null);
    setDeckOpen(false);
  }, [organizationId, publicationId, startMonth, endMonth, chartType]);

  const fetchOne = useCallback(
    async (
      preset: QbrPreset,
      signal: AbortSignal
    ): Promise<ChartSpec> => {
      const res = await fetch("/api/qbr-charts/chart-spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: preset.questionId,
          chartType,
          organizationId: organizationId.trim(),
          publicationId: publicationId.trim() || undefined,
          startMonth: startMonth || undefined,
          endMonth: endMonth || undefined,
        }),
        signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (body.error === "MISSING_REQUIRED_PARAMS") {
          throw new Error("Needs extra params not in the standard set");
        }
        throw new Error(
          body.message ?? body.error ?? `Request failed (${res.status})`
        );
      }
      const json = (await res.json()) as { spec: ChartSpec };
      return json.spec;
    },
    [chartType, organizationId, publicationId, startMonth, endMonth]
  );

  const handleLoadAll = useCallback(async () => {
    if (!canRun || isRunning) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setGlobalError(null);
    setSpecs({});
    setSelectedQuestionId(null);

    // Seed all tiles to idle so the grid shows the full slate
    // immediately (previously empty Record produced "Idle" but no
    // visible upcoming work).
    const initial: Record<number, TileState> = {};
    for (const p of QBR_PRESETS) initial[p.questionId] = { status: "idle" };
    setTileStates(initial);

    try {
      for (const preset of QBR_PRESETS) {
        if (controller.signal.aborted) return;
        setTileStates((s) => ({
          ...s,
          [preset.questionId]: { status: "loading" },
        }));
        try {
          const spec = await fetchOne(preset, controller.signal);
          if (controller.signal.aborted) return;
          const hasData = specHasData(spec);
          setSpecs((m) => ({ ...m, [preset.questionId]: spec }));
          setTileStates((s) => ({
            ...s,
            [preset.questionId]: {
              status: "ready",
              hasData,
              // Auto-include in the deck only when the chart has
              // data. No-data charts can be added back manually from
              // the single-chart view.
              inDeck: hasData,
            },
          }));
        } catch (e) {
          if (controller.signal.aborted) return;
          const msg = e instanceof Error ? e.message : "Failed";
          setTileStates((s) => ({
            ...s,
            [preset.questionId]: { status: "error", error: msg },
          }));
        }
      }
    } finally {
      if (!controller.signal.aborted) setIsRunning(false);
    }
  }, [canRun, isRunning, fetchOne]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRunning(false);
  }, []);

  // Tile click: ready → render cached spec; error → retry that one;
  // idle/loading → no-op (the grid already disables the button, but
  // be defensive).
  const handleTileClick = useCallback(
    async (preset: QbrPreset) => {
      const current = tileStates[preset.questionId];
      if (!current) return;
      if (current.status === "ready") {
        if (specs[preset.questionId]) setSelectedQuestionId(preset.questionId);
        return;
      }
      if (current.status === "error") {
        // Single-tile retry. Reuses the same abort signal as the
        // batch if one is live; otherwise mints a fresh one so the
        // user can keep retrying after a batch ends.
        const controller = abortRef.current ?? new AbortController();
        if (!abortRef.current) abortRef.current = controller;
        setTileStates((s) => ({
          ...s,
          [preset.questionId]: { status: "loading" },
        }));
        try {
          const spec = await fetchOne(preset, controller.signal);
          if (controller.signal.aborted) return;
          const hasData = specHasData(spec);
          setSpecs((m) => ({ ...m, [preset.questionId]: spec }));
          setTileStates((s) => ({
            ...s,
            [preset.questionId]: { status: "ready", hasData, inDeck: hasData },
          }));
        } catch (e) {
          if (controller.signal.aborted) return;
          const msg = e instanceof Error ? e.message : "Failed";
          setTileStates((s) => ({
            ...s,
            [preset.questionId]: { status: "error", error: msg },
          }));
        }
      }
    },
    [tileStates, specs, fetchOne]
  );

  const readyCount = Object.values(tileStates).filter(
    (s) => s.status === "ready"
  ).length;
  const totalCount = QBR_PRESETS.length;
  const selectedSpec =
    selectedQuestionId != null ? specs[selectedQuestionId] ?? null : null;
  const selectedState =
    selectedQuestionId != null ? tileStates[selectedQuestionId] : undefined;

  // Slide-deck composition. We walk the presets in their declared
  // order so the deck order matches the grid; later this becomes
  // user-orderable when the design lands.
  const deckSlides = useMemo<DeckSlide[]>(() => {
    const out: DeckSlide[] = [];
    for (const p of QBR_PRESETS) {
      const state = tileStates[p.questionId];
      const spec = specs[p.questionId];
      if (state?.status === "ready" && state.inDeck && spec) {
        out.push({ questionId: p.questionId, spec });
      }
    }
    return out;
  }, [tileStates, specs]);

  const toggleDeckForCurrent = useCallback(() => {
    if (selectedQuestionId == null) return;
    setTileStates((s) => {
      const t = s[selectedQuestionId];
      if (!t || t.status !== "ready") return s;
      return {
        ...s,
        [selectedQuestionId]: { ...t, inDeck: !t.inDeck },
      };
    });
  }, [selectedQuestionId]);

  const removeFromDeck = useCallback((questionId: number) => {
    setTileStates((s) => {
      const t = s[questionId];
      if (!t || t.status !== "ready") return s;
      return { ...s, [questionId]: { ...t, inDeck: false } };
    });
  }, []);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="bg-surface border border-border rounded-xl shadow-card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <WorkspacePicker
            workspaces={workspaces}
            csm={csm}
            isAdmin={isAdmin}
            value={organizationId}
            onChange={setOrganizationId}
            disabled={isRunning}
          />
          <PublicationPicker
            workspaceId={organizationId}
            value={publicationId}
            onChange={setPublicationId}
            disabled={isRunning}
          />
          <DateField
            label="Start month"
            value={startMonth}
            onChange={setStartMonth}
            disabled={isRunning}
          />
          <DateField
            label="End month"
            value={endMonth}
            onChange={setEndMonth}
            disabled={isRunning}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-xs text-muted flex items-center gap-2">
            Chart type
            <select
              value={chartType}
              onChange={(e) =>
                setChartType(e.target.value as ChartType | "auto")
              }
              disabled={isRunning}
              className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg disabled:opacity-50"
            >
              <option value="auto">Auto (preset default)</option>
              <option value="line">Line</option>
              <option value="bar">Bar</option>
              <option value="stacked-bar">Stacked bar</option>
              <option value="area">Area</option>
              <option value="stacked-area">Stacked area</option>
              <option value="combo">Combo</option>
              <option value="pie">Pie</option>
              <option value="donut">Donut</option>
              <option value="scalar">Scalar</option>
              <option value="scatter">Scatter</option>
              <option value="table">Table</option>
            </select>
          </label>
          {isRunning ? (
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-surface text-fg hover:bg-canvas/40"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={handleLoadAll}
              disabled={!canRun}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {hasResults ? "Reload charts" : "Load charts"}
            </button>
          )}
          {hasResults ? (
            <span className="text-[11px] text-muted">
              {readyCount}/{totalCount} ready · {deckSlides.length} in deck
            </span>
          ) : null}
          {deckSlides.length > 0 ? (
            <button
              type="button"
              onClick={() => setDeckOpen(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-accent/40 text-accent bg-surface hover:bg-canvas/40"
            >
              Generate deck ({deckSlides.length})
            </button>
          ) : null}
          {selectedSpec ? (
            <button
              type="button"
              onClick={() => setSelectedQuestionId(null)}
              className="ml-auto text-xs text-accent hover:underline"
            >
              ← Back to all charts
            </button>
          ) : null}
        </div>
        {!canRun ? (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
            Pick a workspace to enable the preset tiles.
          </p>
        ) : null}
      </div>

      {globalError ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {globalError}
        </div>
      ) : null}

      {selectedSpec ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            {selectedState?.hasData === false ? (
              <span className="px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30">
                No data detected
              </span>
            ) : null}
            <button
              type="button"
              onClick={toggleDeckForCurrent}
              className="ml-auto px-2.5 py-1 rounded-md border border-border bg-surface text-fg hover:bg-canvas/40"
            >
              {selectedState?.inDeck ? "Remove from deck" : "Add to deck"}
            </button>
          </div>
          <ChartCard spec={selectedSpec} />
        </div>
      ) : (
        <PresetGrid
          disabled={!canRun}
          onPick={handleTileClick}
          states={tileStates}
        />
      )}

      {deckOpen ? (
        <DeckPreview
          slides={deckSlides}
          onClose={() => setDeckOpen(false)}
          onRemoveSlide={removeFromDeck}
        />
      ) : null}
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg disabled:opacity-50"
      />
    </label>
  );
}
