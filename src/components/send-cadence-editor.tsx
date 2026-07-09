"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Small client island for viewing + editing a workspace's expected
 * send cadence. Renders the inferred cadence (from the daily sweep)
 * as the read-only baseline; when a CSM opens the editor they can
 * pin an override that trumps the inferred value in Flag A's
 * threshold calculation.
 *
 * The override is stored via /api/customer-overrides — same shape as
 * the lifecycle_stage / interval overrides. Clearing (empty value)
 * removes it; Flag A then falls back to inferred → default(10).
 *
 * Not gated behind a two-step confirm — this is a low-blast-radius
 * edit (changing at-risk thresholds for one workspace). We use
 * router.refresh() to pick up the new value on the next server
 * render.
 */
interface Props {
  workspaceId: string;
  /** Manual override currently in force (days), if any. */
  overrideDays: number | null;
  /** ClickHouse-inferred median days between sends (last 120d). Null
   *  when the workspace has < 3 sends in the lookback. */
  inferredDays: number | null;
  /** Sample size the inferred value was medianed from. */
  inferredSampleSize: number | null;
  /** ISO date the sweep last updated the inferred value. */
  inferredUpdatedAt: string | null;
}

const TOLERANCE_DAYS = 14;
const DEFAULT_DAYS = 10;

export function SendCadenceEditor({
  workspaceId,
  overrideDays,
  inferredDays,
  inferredSampleSize,
  inferredUpdatedAt,
}: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    overrideDays != null ? String(overrideDays) : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Effective cadence used by Flag A — max(override, inferred, default).
  // Kept in the UI so a CSM can predict when the flag would fire
  // without spelunking through code.
  const effective = Math.max(
    overrideDays ?? 0,
    inferredDays ?? 0,
    DEFAULT_DAYS
  );
  const threshold = effective + TOLERANCE_DAYS;
  const effectiveSource =
    overrideDays != null && overrideDays >= effective
      ? "CSM-set"
      : inferredDays != null && inferredDays >= effective
        ? "inferred"
        : "default (10d floor)";

  async function save(next: number | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          expected_send_cadence_days: next,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      void save(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a positive number of days, or leave blank to clear.");
      return;
    }
    if (parsed > 365) {
      setError("Cadence over 365 days doesn't make sense — clear instead.");
      return;
    }
    void save(Math.floor(parsed));
  }

  const inferredTooltip = inferredDays
    ? `Median of ${inferredSampleSize ?? "?"} sends over the last 120 days` +
      (inferredUpdatedAt
        ? ` — recomputed ${inferredUpdatedAt.slice(0, 10)}.`
        : ".")
    : "Not enough send history in the last 120 days to infer a cadence.";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span title={inferredTooltip} className="text-muted">
          Inferred:{" "}
          <span className="font-medium text-fg">
            {inferredDays != null ? `${inferredDays}d` : "insufficient history"}
          </span>
        </span>
        <span className="text-subtle">·</span>
        <span title="Manual override — trumps inferred in Flag A's threshold when set.">
          Override:{" "}
          <span className="font-medium text-fg">
            {overrideDays != null ? `${overrideDays}d` : "—"}
          </span>
        </span>
        {!editing ? (
          <button
            type="button"
            onClick={() => {
              setValue(overrideDays != null ? String(overrideDays) : "");
              setEditing(true);
              setError(null);
            }}
            className="text-accent hover:underline"
          >
            {overrideDays != null ? "Edit" : "Set"}
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[11px] text-muted inline-flex items-center gap-1">
            Every
            <input
              type="number"
              min={1}
              max={365}
              step={1}
              value={value}
              disabled={busy}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder={inferredDays ? String(inferredDays) : "e.g. 30"}
              className="w-20 px-2 py-1 text-xs rounded border border-border-strong bg-surface"
            />
            days
          </label>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="px-2 py-0.5 text-[11px] rounded-md font-medium border bg-accent text-white border-accent hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={busy}
            className="px-2 py-0.5 text-[11px] rounded-md text-muted hover:text-fg"
          >
            Cancel
          </button>
          {overrideDays != null ? (
            <button
              type="button"
              onClick={() => {
                setValue("");
                void save(null);
              }}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] rounded-md text-muted hover:text-red-700 dark:hover:text-red-300"
              title="Remove the override and fall back to inferred / default."
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className="text-[11px] text-subtle"
        title={`Flag A fires when last send is older than ${effective}d (${effectiveSource}) + ${TOLERANCE_DAYS}d tolerance = ${threshold}d.`}
      >
        Flag A threshold: <span className="tabular-nums">{threshold}d</span>{" "}
        <span className="text-muted">
          ({effective}d {effectiveSource} + {TOLERANCE_DAYS}d)
        </span>
      </div>
      {error ? (
        <div className="text-[11px] text-red-700 dark:text-red-300">{error}</div>
      ) : null}
    </div>
  );
}
