"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CandidateWin, WinsBlob } from "@/lib/data/wins-types";
import { CollapsibleSection } from "./collapsible-section";

/**
 * Wins & Opportunities — Phase 1 read-only list.
 *
 * Not a card grid yet — that's Phase 2. This surface exists so
 * Hayden / Jacob can validate detection quality on real book data:
 * per-customer collapsible sections, one row per candidate with the
 * rule headline, metric, and mapped opportunity, plus a Dismiss
 * affordance and a filter chip strip. Suppressed wins render inline
 * with a muted style so we can also validate the at-risk
 * suppression logic in the same view.
 */

type FilterChip = "all" | "new_today" | "suppressed";

const CATEGORY_LABELS: Record<string, string> = {
  craft: "Craft",
  consistency: "Consistency",
  "list-health": "List health",
  momentum: "Momentum",
  monetization: "Monetization",
};

const CATEGORY_COLORS: Record<string, string> = {
  craft: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  consistency: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  "list-health": "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  momentum: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  monetization: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

function isToday(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

function formatMetric(win: CandidateWin): string {
  if (win.win_type === "quality_growth") {
    return `${Math.round(win.metric_value).toLocaleString()} engaged (from ${Math.round(win.comparison_value).toLocaleString()})`;
  }
  return `${(win.metric_value * 100).toFixed(1)}% vs ${(win.comparison_value * 100).toFixed(1)}%`;
}

function formatDetected(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface WinRowProps {
  win: CandidateWin;
  onDismissed: (winId: string) => void;
}

function WinRow({ win, onDismissed }: WinRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function dismissWin() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/wins/${win.win_id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "dismissed" }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        onDismissed(win.win_id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      }
    });
  }

  const categoryClass = CATEGORY_COLORS[win.category] ?? "bg-surface-2 text-muted";
  const mutedClass = win.suppressed ? "opacity-60" : "";

  return (
    <div
      className={`border border-border rounded-md p-3 bg-canvas/40 ${mutedClass}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span
              className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${categoryClass}`}
            >
              {CATEGORY_LABELS[win.category] ?? win.category}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted">
              {win.win_type.replace(/_/g, " ")}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted">
              • {win.confidence} confidence
            </span>
            {win.suppressed ? (
              <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400 font-semibold">
                • Suppressed
              </span>
            ) : null}
          </div>
          <p className="text-sm font-medium text-fg leading-snug">
            {win.headline}
          </p>
          {win.publication_name ? (
            <p className="text-xs text-muted mt-0.5">
              {win.publication_name}
            </p>
          ) : null}
          <p className="text-xs text-muted mt-1">
            <span className="font-medium">Signal:</span> {formatMetric(win)}
          </p>
          <p className="text-xs text-fg/80 mt-2 italic">
            → {win.mapped_opportunity}
          </p>
          {win.suppressed && win.suppression_reason ? (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
              {win.suppression_reason}
            </p>
          ) : null}
          {error ? (
            <p className="text-xs text-red-600 dark:text-red-400 mt-2">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex-shrink-0 flex items-center gap-2">
          {win.status === "dismissed" ? (
            <span className="text-xs text-muted italic">Dismissed</span>
          ) : confirming ? (
            <>
              <button
                type="button"
                onClick={dismissWin}
                disabled={pending}
                className="text-xs px-2 py-1 rounded border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20 disabled:opacity-60"
              >
                {pending ? "Dismissing…" : "Confirm dismiss"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="text-xs text-muted hover:text-fg"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="text-xs px-2 py-1 rounded border border-border text-muted hover:bg-surface-2"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface WinsListProps {
  blob: WinsBlob;
  csmName: string | null;
  isAdmin: boolean;
}

export function WinsList({ blob, csmName, isAdmin }: WinsListProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterChip>("all");
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Scope + filter + hide-dismissed all live client-side. The KV blob
  // is loaded on the server side of /csm and passed in whole.
  const scoped = useMemo(() => {
    const all = Object.values(blob.candidates);
    const byCsm = csmName ? all.filter((w) => w.csm_name === csmName) : all;
    const withoutDismissed = byCsm.filter((w) => {
      if (dismissedIds.has(w.win_id)) return false;
      if (w.status === "dismissed") return false;
      return true;
    });
    if (filter === "all") return withoutDismissed.filter((w) => !w.suppressed);
    if (filter === "new_today") {
      return withoutDismissed.filter(
        (w) => !w.suppressed && isToday(w.detected_at)
      );
    }
    return withoutDismissed.filter((w) => w.suppressed);
  }, [blob.candidates, csmName, filter, dismissedIds]);

  const counts = useMemo(() => {
    const all = Object.values(blob.candidates);
    const byCsm = csmName ? all.filter((w) => w.csm_name === csmName) : all;
    const active = byCsm.filter(
      (w) => w.status !== "dismissed" && !dismissedIds.has(w.win_id)
    );
    return {
      all: active.filter((w) => !w.suppressed).length,
      new_today: active.filter(
        (w) => !w.suppressed && isToday(w.detected_at)
      ).length,
      suppressed: active.filter((w) => w.suppressed).length,
    };
  }, [blob.candidates, csmName, dismissedIds]);

  const grouped = useMemo(() => {
    const groups = new Map<string, { name: string; wins: CandidateWin[] }>();
    for (const win of scoped) {
      const entry = groups.get(win.account_id) ?? {
        name: win.workspace_name ?? "Unknown workspace",
        wins: [] as CandidateWin[],
      };
      entry.wins.push(win);
      groups.set(win.account_id, entry);
    }
    return Array.from(groups.entries()).sort(([, a], [, b]) =>
      a.name.localeCompare(b.name)
    );
  }, [scoped]);

  async function runDetection() {
    setRunning(true);
    setRunResult(null);
    setRunError(null);
    try {
      const res = await fetch("/api/wins/detect", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRunError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setRunResult(
        `Scanned ${body.scanned_publications ?? 0} publications across ${body.scanned_workspaces ?? 0} workspaces — detected ${body.detected ?? 0}, held ${body.suppressed_at_risk ?? 0} for at-risk.`
      );
      router.refresh();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Network error");
    } finally {
      setRunning(false);
    }
  }

  const lastRun = blob.last_detection_at
    ? formatDetected(blob.last_detection_at)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            {lastRun
              ? `Last detection run: ${lastRun}`
              : "No detection run yet — click Run detection now to populate."}
          </p>
          <p className="text-xs text-muted mt-0.5">
            Phase 1 · raw open/click metrics · self-comparison rules only.
            Ranking, curation, and outreach drafting ship in later phases.
          </p>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={runDetection}
            disabled={running}
            className="text-sm px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-surface-2 disabled:opacity-60"
          >
            {running ? "Detecting…" : "Run detection now"}
          </button>
        ) : null}
      </div>

      {runResult ? (
        <div className="text-xs bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 rounded-md px-3 py-2">
          {runResult}
        </div>
      ) : null}
      {runError ? (
        <div className="text-xs bg-red-50 dark:bg-red-500/10 border border-red-500/30 text-red-800 dark:text-red-300 rounded-md px-3 py-2">
          Detection failed: {runError}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            { id: "all" as const, label: "Active", count: counts.all },
            {
              id: "new_today" as const,
              label: "New today",
              count: counts.new_today,
            },
            {
              id: "suppressed" as const,
              label: "Suppressed",
              count: counts.suppressed,
            },
          ] satisfies Array<{ id: FilterChip; label: string; count: number }>
        ).map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={() => setFilter(chip.id)}
            className={`text-xs px-2.5 py-1 rounded-full border ${
              filter === chip.id
                ? "bg-fg text-canvas border-fg"
                : "bg-surface text-muted border-border hover:bg-surface-2"
            }`}
          >
            {chip.label}{" "}
            <span className="ml-1 opacity-70">({chip.count})</span>
          </button>
        ))}
      </div>

      {grouped.length === 0 ? (
        <div className="text-sm text-muted italic bg-surface border border-border rounded-md p-4">
          {filter === "suppressed"
            ? "No suppressed wins right now — every candidate cleared the at-risk gate."
            : filter === "new_today"
              ? "No wins detected today. The daily cron writes at ~05:15 UTC — check back later or run detection now."
              : "No active wins for this scope yet. Run detection to scan the book, or wait for the daily cron."}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(([workspaceId, group]) => (
            <CollapsibleSection
              key={workspaceId}
              title={`${group.name} (${group.wins.length})`}
              defaultOpen
              bodyClassName="p-3 space-y-2"
            >
              {group.wins.map((win) => (
                <WinRow
                  key={win.win_id}
                  win={win}
                  onDismissed={(id) =>
                    setDismissedIds((prev) => {
                      const next = new Set(prev);
                      next.add(id);
                      return next;
                    })
                  }
                />
              ))}
            </CollapsibleSection>
          ))}
        </div>
      )}
    </div>
  );
}
