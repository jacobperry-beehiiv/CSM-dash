"use client";

import { useCallback, useState } from "react";
import { ChartCard } from "./chart-card";
import { PresetGrid } from "./preset-grid";
import type {
  ChartSpec,
  ChartType,
  QbrPreset,
} from "@/lib/qbr-charts/types";

/**
 * The /csm?tab=qbr-charts orchestrator. Holds:
 *   - The four shared inputs (workspace id, optional publication id,
 *     optional date range).
 *   - The selected ChartSpec (one at a time per Hayden's spec).
 *   - Per-tile loading state so a click can disable just the one
 *     preset while it loads, not the whole grid.
 *
 * PR A scope:
 *   - Preset grid (17 tiles) → click → render.
 *   - Chart-type override (auto/line/bar/...).
 *   - Workspace + publication modes via the two ID fields.
 *
 * Out of scope (later PRs):
 *   - Free-text prompt input (PR B — wires Claude).
 *   - Metabase search for non-QBR questions (PR C).
 *   - ExtraParams form for non-standard params (PR C).
 */
export function QbrChartsTab() {
  const [organizationId, setOrganizationId] = useState("");
  const [publicationId, setPublicationId] = useState("");
  const [startMonth, setStartMonth] = useState("");
  const [endMonth, setEndMonth] = useState("");
  const [chartType, setChartType] = useState<ChartType | "auto">("auto");

  const [spec, setSpec] = useState<ChartSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingQuestionId, setLoadingQuestionId] = useState<number | null>(null);

  const canRun = organizationId.trim().length > 0;

  const handlePresetClick = useCallback(
    async (preset: QbrPreset) => {
      if (!canRun) return;
      setLoadingQuestionId(preset.questionId);
      setError(null);
      try {
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
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
            missingParams?: unknown;
          };
          if (body.error === "MISSING_REQUIRED_PARAMS") {
            setError(
              "This chart needs extra parameters that aren't in the standard set yet. Pasting the question into Metabase directly works in the meantime; full ExtraParams support lands in PR C."
            );
          } else {
            setError(
              body.message ?? body.error ?? `Request failed (${res.status})`
            );
          }
          return;
        }
        const json = (await res.json()) as { spec: ChartSpec };
        setSpec(json.spec);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load chart");
      } finally {
        setLoadingQuestionId(null);
      }
    },
    [
      canRun,
      organizationId,
      publicationId,
      startMonth,
      endMonth,
      chartType,
    ]
  );

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="bg-surface border border-border rounded-xl shadow-card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field
            label="Workspace ID"
            required
            value={organizationId}
            onChange={setOrganizationId}
            placeholder="UUID — required"
          />
          <Field
            label="Publication ID"
            value={publicationId}
            onChange={setPublicationId}
            placeholder="Optional — narrows to one pub"
            hint="Leave blank for workspace-wide charts."
          />
          <Field
            type="date"
            label="Start month"
            value={startMonth}
            onChange={setStartMonth}
          />
          <Field
            type="date"
            label="End month"
            value={endMonth}
            onChange={setEndMonth}
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <label className="text-xs text-muted flex items-center gap-2">
            Chart type
            <select
              value={chartType}
              onChange={(e) => setChartType(e.target.value as ChartType | "auto")}
              className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
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
          {spec ? (
            <button
              type="button"
              onClick={() => setSpec(null)}
              className="ml-auto text-xs text-accent hover:underline"
            >
              ← Back to all charts
            </button>
          ) : null}
        </div>
        {!canRun ? (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
            Paste a workspace ID to enable the preset tiles.
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {spec ? (
        <ChartCard spec={spec} />
      ) : (
        <PresetGrid
          disabled={!canRun}
          onPick={handlePresetClick}
          loadingQuestionId={loadingQuestionId}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  type?: "text" | "date";
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted">
        {label}
        {required ? <span className="text-red-600 ml-0.5">*</span> : null}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
      />
      {hint ? <span className="text-[10px] text-subtle">{hint}</span> : null}
    </label>
  );
}
