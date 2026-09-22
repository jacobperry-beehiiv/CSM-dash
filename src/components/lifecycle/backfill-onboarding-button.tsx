"use client";

import { useState } from "react";
import type { LifecycleStep } from "@/lib/lifecycle/card";

interface Props {
  workspaceId: string;
  onBackfilled: (steps: LifecycleStep[]) => void;
}

/**
 * Renders in place of the checklist on an Onboarding card that has
 * zero matched steps — i.e. Slack's "@bot assign" was never run for
 * this customer, so there's no underlying to-do data to show (see
 * /api/lifecycle/backfill-onboarding). One-off recovery action, not a
 * default the board takes on its own — the CSM has to explicitly
 * confirm it. Same idle → confirming → sending state shape as the
 * Slack-send confirm button (todo-action-button.tsx).
 *
 * Stops click/drag propagation, same as StageTodoList, so using this
 * never opens the card modal or starts a drag.
 */
export function BackfillOnboardingButton({ workspaceId, onBackfilled }: Props) {
  const [state, setState] = useState<"idle" | "confirming" | "sending" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState("sending");
    setError(null);
    try {
      const r = await fetch("/api/lifecycle/backfill-onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        steps?: LifecycleStep[];
        error?: string;
      };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onBackfilled(body.steps ?? []);
      setState("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backfill failed");
      setState("error");
    }
  }

  return (
    <div
      className="mt-2"
      onClick={(e) => e.stopPropagation()}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
    >
      {state === "confirming" || state === "sending" ? (
        <div className="rounded border border-border bg-canvas p-2 space-y-1.5">
          <p className="text-[11px] text-subtle">
            Seeds the full ~90-day onboarding to-do sequence (17 steps,
            dated from today) on your personal list for this customer —
            the same one <code>@bot assign</code> normally creates. Use
            this only if that was never run for them; it won&apos;t run
            again if a checklist already exists.
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={run}
              disabled={state === "sending"}
              className="px-1.5 py-0.5 rounded border border-emerald-400 dark:border-emerald-500/50 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 disabled:opacity-50 text-[11px]"
            >
              {state === "sending" ? "Seeding…" : "Yes, seed it"}
            </button>
            <button
              type="button"
              onClick={() => setState("idle")}
              disabled={state === "sending"}
              className="px-1.5 py-0.5 rounded border border-border text-subtle hover:bg-canvas/60 disabled:opacity-50 text-[11px]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setState("confirming")}
          className="w-full text-[11px] px-2 py-1 rounded border border-dashed border-border-strong text-subtle hover:bg-canvas hover:text-fg"
        >
          No checklist found — seed onboarding steps?
        </button>
      )}
      {error ? (
        <div className="text-[11px] text-red-700 dark:text-red-300 mt-1">
          {error}
        </div>
      ) : null}
    </div>
  );
}
