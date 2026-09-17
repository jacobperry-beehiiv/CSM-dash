"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChartCard } from "./chart-card";
import {
  DeckPreview,
  type DeckContext,
  type DeckSlide,
} from "./deck-preview";
import { PresetGrid, type TileState } from "./preset-grid";
import {
  WorkspacePicker,
  type WorkspaceOption,
} from "./workspace-picker";
import { PublicationPicker } from "./publication-picker";
import { AxisEditor } from "./axis-editor";
import { useWorkspacePublications } from "@/lib/hooks/customer-publications-cache";
import { QBR_PRESETS } from "@/lib/qbr-charts/qbr-presets";
import { specHasData } from "@/lib/qbr-charts/has-data";
import {
  applyAxisOverride,
  type AxisOverride,
} from "@/lib/qbr-charts/axis-override";
import {
  dataUrlToBytes,
  downloadBlob,
  slugForFilename,
  snapshotElement,
  waitForCardReady,
  zipFilename,
  zipPngs,
} from "@/lib/qbr-charts/png-export";
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
 *      (or → error) as its query lands. Charts with no usable data
 *      get a "No data" badge and are auto-skipped from the deck.
 *   5. Click any ready tile to render the cached chart. Click an
 *      errored tile to retry just that one.
 *   6. Click "Generate deck" → full-screen overlay renders the
 *      Erzulie-style customer deck with cover + section divider +
 *      one slide per hasData chart + thank-you slide. Print → PDF.
 *
 * Why sequential? Heavy QBR queries can run 30-90s on a cold
 * Metabase cache. Firing 17 in parallel hammers Metabase and risks
 * 504s; sequential keeps load gentle and lets early-finishing tiles
 * become clickable well before the full set is done.
 *
 * Cancellation: any input change (workspace, publication, dates,
 * chart-type override) aborts the in-flight queue, clears cached
 * specs, and resets all tiles. A stale spec rendered after a
 * workspace switch would be a UX trap.
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
  // Per-tile axis overrides. Keyed by questionId. Cleared on any
  // input change (same reset semantics as `specs`) — a different
  // workspace's data may not have the same columns, so a stale
  // xKey / ySeriesKey selection would render an empty chart.
  const [axisOverrides, setAxisOverrides] = useState<
    Record<number, AxisOverride>
  >({});
  // PNG-export state. `exporting.spec` is the tile currently being
  // captured — rendered into a hidden portal so ResponsiveContainer
  // can size + paint before html-to-image snapshots it. `progress`
  // drives the button label so the CSM sees "3/17…" during a run.
  const [exporting, setExporting] = useState<{
    spec: ChartSpec;
    questionId: number;
  } | null>(null);
  const [exportProgress, setExportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const captureHostRef = useRef<HTMLDivElement | null>(null);
  const capturedCardRef = useRef<HTMLDivElement | null>(null);

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
    setAxisOverrides({});
  }, [organizationId, publicationId, startMonth, endMonth, chartType]);

  // Auto-fill start/end from the selected workspace's contract
  // renewal date. Window is [renewal - 12mo, renewal] when the
  // renewal is in the past (retrospective QBR); when it's upcoming
  // (or missing), end defaults to today and start to 12 months
  // ago so a CSM prepping the QBR early doesn't get a future-
  // dated end.
  useEffect(() => {
    if (!organizationId) return;
    const ws = workspaces.find((w) => w.workspace_id === organizationId);
    const window = defaultQbrWindow(ws?.contract_renewal ?? null);
    setStartMonth(window.start);
    setEndMonth(window.end);
  }, [organizationId, workspaces]);

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

  const handleTileClick = useCallback(
    async (preset: QbrPreset) => {
      const current = tileStates[preset.questionId];
      if (!current) return;
      if (current.status === "ready") {
        if (specs[preset.questionId]) setSelectedQuestionId(preset.questionId);
        return;
      }
      if (current.status === "error") {
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
  // order so the deck order matches the grid. Only hasData specs land
  // in the deck — no-data slides would render empty cards, which the
  // user explicitly does not want in customer-facing output.
  const deckSlides = useMemo<DeckSlide[]>(() => {
    const out: DeckSlide[] = [];
    for (const p of QBR_PRESETS) {
      const state = tileStates[p.questionId];
      const spec = specs[p.questionId];
      if (
        state?.status === "ready" &&
        state.hasData === true &&
        state.inDeck === true &&
        spec
      ) {
        out.push({ questionId: p.questionId, spec });
      }
    }
    return out;
  }, [tileStates, specs]);

  const toggleDeckForCurrent = useCallback(() => {
    if (selectedQuestionId == null) return;
    setTileStates((s) => {
      const t = s[selectedQuestionId];
      if (!t || t.status !== "ready" || t.hasData !== true) return s;
      return { ...s, [selectedQuestionId]: { ...t, inDeck: !t.inDeck } };
    });
  }, [selectedQuestionId]);

  const removeFromDeck = useCallback((questionId: number) => {
    setTileStates((s) => {
      const t = s[questionId];
      if (!t || t.status !== "ready") return s;
      return { ...s, [questionId]: { ...t, inDeck: false } };
    });
  }, []);

  // Deck context — workspace + publication names for the cover and
  // chart slide subtitles. Workspace name from the dropdown options;
  // publication name resolved via the same publications cache the
  // picker uses.
  const workspaceName =
    workspaces.find((w) => w.workspace_id === organizationId)?.workspace_name ??
    null;
  const publications = useWorkspacePublications(organizationId);
  const publicationName =
    publicationId && Array.isArray(publications)
      ? publications.find((p) => p.publication_id === publicationId)
          ?.publication_name ?? null
      : null;
  const deckContext: DeckContext = {
    workspaceName,
    publicationName,
    startMonth: startMonth || null,
    endMonth: endMonth || null,
  };

  // Exportable set — every hasData tile, in preset order (matches the
  // deck ordering). Independent of the "inDeck" toggle since a CSM
  // may want the raw PNGs for charts they've excluded from a formal
  // deck. Each entry carries the axis-override-applied spec so the
  // exported PNG reflects the CSM's edits.
  const exportableSpecs = useMemo<
    Array<{ questionId: number; spec: ChartSpec }>
  >(() => {
    const out: Array<{ questionId: number; spec: ChartSpec }> = [];
    for (const p of QBR_PRESETS) {
      const state = tileStates[p.questionId];
      const spec = specs[p.questionId];
      if (state?.status === "ready" && state.hasData === true && spec) {
        out.push({
          questionId: p.questionId,
          spec: applyAxisOverride(spec, axisOverrides[p.questionId]),
        });
      }
    }
    return out;
  }, [tileStates, specs, axisOverrides]);

  const handleExportPngs = useCallback(async () => {
    if (exporting !== null || exportableSpecs.length === 0) return;
    setExportMessage(null);
    setExportProgress({ done: 0, total: exportableSpecs.length });
    const captures: Array<{ filename: string; bytes: Uint8Array }> = [];
    try {
      for (let i = 0; i < exportableSpecs.length; i++) {
        const { questionId, spec } = exportableSpecs[i];
        // Mount the card in the offscreen host, wait for Recharts to
        // paint at 960px, snapshot, then unmount before the next
        // tile. One-at-a-time keeps memory bounded and lets Recharts
        // reuse its sizing infrastructure without cross-tile
        // interference.
        setExporting({ questionId, spec });
        await waitForCardReady();
        if (!capturedCardRef.current) {
          throw new Error("Offscreen chart card failed to mount");
        }
        const dataUrl = await snapshotElement(capturedCardRef.current);
        captures.push({
          filename: slugForFilename(spec.title, questionId),
          bytes: dataUrlToBytes(dataUrl),
        });
        setExportProgress({ done: i + 1, total: exportableSpecs.length });
      }
      setExporting(null);
      const blob = await zipPngs(captures);
      const workspaceSlug = (workspaceName ?? "qbr")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      downloadBlob(blob, zipFilename(`qbr-${workspaceSlug || "charts"}`));
      setExportMessage(
        `Downloaded ${captures.length} chart${
          captures.length === 1 ? "" : "s"
        } as .zip.`
      );
    } catch (e) {
      setExporting(null);
      setExportMessage(
        `Export failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setExportProgress(null);
      window.setTimeout(() => setExportMessage(null), 8000);
    }
  }, [exportableSpecs, exporting, workspaceName]);

  // Offscreen host for the export flow. Lives outside every layout
  // container (fixed, off-viewport, z:-1) so Recharts sees a proper
  // 960px width and html-to-image can capture a clean chrome-free
  // snapshot without any of the surrounding app UI bleeding in.
  useEffect(() => {
    const host = document.createElement("div");
    host.setAttribute("data-qbr-export-host", "");
    host.style.position = "fixed";
    host.style.left = "-99999px";
    host.style.top = "0";
    host.style.width = "1000px";
    host.style.pointerEvents = "none";
    host.style.zIndex = "-1";
    document.body.appendChild(host);
    captureHostRef.current = host;
    return () => {
      host.remove();
      captureHostRef.current = null;
    };
  }, []);

  const setAxisOverrideForQuestion = useCallback(
    (questionId: number, next: AxisOverride | undefined) => {
      setAxisOverrides((prev) => {
        const copy = { ...prev };
        if (next) copy[questionId] = next;
        else delete copy[questionId];
        return copy;
      });
    },
    []
  );

  return (
    <div className="space-y-4">
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
          {exportableSpecs.length > 0 ? (
            <button
              type="button"
              onClick={handleExportPngs}
              disabled={exporting !== null}
              title="Snapshot every ready tile at 960px and download as a .zip of PNGs. Uses whatever axis edits you've made per tile."
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-strong text-fg bg-surface hover:bg-canvas/40 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {exportProgress
                ? `Capturing ${exportProgress.done}/${exportProgress.total}…`
                : `Download all as PNGs (${exportableSpecs.length})`}
            </button>
          ) : null}
          {exportMessage ? (
            <span className="text-[11px] text-muted">{exportMessage}</span>
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
                No data — auto-excluded from the deck
              </span>
            ) : null}
            {selectedState?.hasData === true ? (
              <button
                type="button"
                onClick={toggleDeckForCurrent}
                className="ml-auto px-2.5 py-1 rounded-md border border-border bg-surface text-fg hover:bg-canvas/40"
              >
                {selectedState.inDeck ? "Remove from deck" : "Add to deck"}
              </button>
            ) : null}
          </div>
          {selectedQuestionId != null ? (
            <ChartCard
              spec={applyAxisOverride(
                selectedSpec,
                axisOverrides[selectedQuestionId]
              )}
              headerActions={
                <AxisEditor
                  spec={selectedSpec}
                  override={axisOverrides[selectedQuestionId]}
                  onChange={(next) =>
                    setAxisOverrideForQuestion(selectedQuestionId, next)
                  }
                />
              }
            />
          ) : null}
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
          context={deckContext}
          onClose={() => setDeckOpen(false)}
          onRemoveSlide={removeFromDeck}
        />
      ) : null}

      {/* Offscreen capture — active only while handleExportPngs is
       *  cycling through tiles. Portalled to <body> so it lives
       *  outside every layout container and Recharts sees a
       *  proper 960px parent width. */}
      {exporting && captureHostRef.current
        ? createPortal(
            <ChartCard ref={capturedCardRef} spec={exporting.spec} />,
            captureHostRef.current
          )
        : null}
    </div>
  );
}

/** Default 12-month QBR window from an optional contract renewal
 *  date. Returns ISO yyyy-mm-dd strings matching the format
 *  <input type="date"> writes back into the DateField.
 *
 *  Rules (per product ask):
 *    • contract_renewal set AND in the past / today
 *        → end = renewal, start = renewal - 12 months  (retrospective QBR)
 *    • contract_renewal upcoming OR missing
 *        → end = today,   start = today   - 12 months  (early-prep QBR;
 *          never surface a future end date the CSM would have to fix)
 */
function defaultQbrWindow(renewalIso: string | null): {
  start: string;
  end: string;
} {
  const today = startOfLocalDay(new Date());
  let end = today;
  if (renewalIso) {
    const renewal = startOfLocalDay(new Date(renewalIso));
    if (!Number.isNaN(renewal.getTime()) && renewal.getTime() <= today.getTime()) {
      end = renewal;
    }
  }
  const start = new Date(end);
  start.setMonth(start.getMonth() - 12);
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
