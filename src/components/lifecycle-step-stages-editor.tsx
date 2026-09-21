"use client";

import { useMemo, useState } from "react";
import { PLAYBOOK_STEPS } from "@/lib/lifecycle/step-stage-config";
import { ONBOARDING_ASSIGNABLE_STAGES } from "@/lib/lifecycle/onboarding";
import { LIVE_ASSIGNABLE_STAGES } from "@/lib/lifecycle/live-quarter";

/**
 * Client editor for /settings/lifecycle-steps. One dropdown row per
 * playbook step; every dropdown offers BOTH boards' columns (grouped
 * into optgroups) so a step can move from Onboarding to Live or back —
 * which table a row currently renders in reflects its CURRENT selected
 * value, not the board it originated from, so a reassignment visibly
 * "moves" the row between tables as soon as you pick a new column.
 *
 * A step with no resolved stage (a new one Normbot's playbook grew
 * that nobody's placed yet — see step-stage-config.ts's `null`
 * default_stage) renders in a third "Unassigned" table with no column
 * picked; Save only ever writes real, non-empty selections.
 *
 * Same dirty-tracking / Save-Reset shape as the Access allowlist
 * editor (access-allowlist-editor.tsx) — local state until Saved,
 * PUT the whole map back, echo the server's resolved response.
 */

interface Props {
  initial: Record<string, string | null>;
}

const UNPLACED = "" as const;

export function LifecycleStepStagesEditor({ initial }: Props) {
  const [stages, setStages] = useState<Record<string, string | null>>(initial);
  const [saved, setSaved] = useState<Record<string, string | null>>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    return PLAYBOOK_STEPS.some((s) => stages[s.step_key] !== saved[s.step_key]);
  }, [stages, saved]);

  function updateStep(stepKey: string, stage: string) {
    setStages((prev) => ({ ...prev, [stepKey]: stage || null }));
    setMessage(null);
  }

  function reset() {
    setStages(saved);
    setMessage(null);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const body: Record<string, string> = {};
      for (const [key, value] of Object.entries(stages)) {
        if (value) body[key] = value;
      }
      const r = await fetch("/api/settings/lifecycle-step-stages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_stages: body }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        step_stages?: Record<string, string | null>;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const next = j.step_stages ?? stages;
      setStages(next);
      setSaved(next);
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  const groups = useMemo(() => {
    const onboarding: typeof PLAYBOOK_STEPS = [];
    const live: typeof PLAYBOOK_STEPS = [];
    const unassigned: typeof PLAYBOOK_STEPS = [];
    for (const s of PLAYBOOK_STEPS) {
      const current = stages[s.step_key] ?? null;
      if (current != null && ONBOARDING_ASSIGNABLE_STAGES.includes(current)) {
        onboarding.push(s);
      } else if (current != null && LIVE_ASSIGNABLE_STAGES.includes(current)) {
        live.push(s);
      } else {
        unassigned.push(s);
      }
    }
    return { onboarding, live, unassigned };
  }, [stages]);

  function renderTable(title: string, steps: typeof PLAYBOOK_STEPS) {
    if (steps.length === 0) return null;
    return (
      <div className="rounded-md border border-border bg-surface p-3 space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </h3>
        <div className="space-y-1.5">
          {steps.map((s) => {
            const value = stages[s.step_key] ?? UNPLACED;
            return (
              <div
                key={s.step_key}
                className="flex items-center justify-between gap-3 py-1"
              >
                <span
                  className="text-sm text-fg min-w-0 truncate"
                  title={s.title}
                >
                  {s.title}
                </span>
                <select
                  value={value}
                  onChange={(e) => updateStep(s.step_key, e.target.value)}
                  className="flex-shrink-0 text-sm px-2 py-1 rounded border border-border bg-canvas"
                >
                  {value === UNPLACED ? (
                    <option value="" disabled>
                      — choose a column —
                    </option>
                  ) : null}
                  <optgroup label="Onboarding">
                    {ONBOARDING_ASSIGNABLE_STAGES.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Live">
                    {LIVE_ASSIGNABLE_STAGES.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      {renderTable("Unassigned", groups.unassigned)}
      {renderTable("Onboarding board steps", groups.onboarding)}
      {renderTable("Live board steps", groups.live)}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="px-4 py-2 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy || !dirty}
          className="px-3 py-2 rounded border border-border-strong text-sm hover:bg-canvas disabled:opacity-50"
        >
          Reset
        </button>
        {message ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {message}
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-red-700 dark:text-red-300">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
