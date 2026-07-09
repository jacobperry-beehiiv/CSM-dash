"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { JulietFlag } from "@/lib/data/juliet-flags-store";

/**
 * Inline toggle for the per-workspace "needs Juliet outreach" flag.
 * Rendered inside the at-risk row's expanded panel and inside the
 * customer detail panel on the /csm "Flagged for Juliet" tab so a
 * CSM can raise from at-risk and Juliet can clear from her queue
 * without a route change.
 *
 * Not gated behind two-step confirm — this is a low-blast-radius
 * team-shared toggle. Optional note appears inline; a raise without
 * a note is fine (any CSM can DM the raiser for context).
 */
interface Props {
  workspaceId: string;
}

export function JulietFlagControl({ workspaceId }: Props) {
  const router = useRouter();
  const [flag, setFlag] = useState<JulietFlag | null>(null);
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the current flag state on mount so a re-open after clearing
  // reflects reality without waiting for router.refresh(). Endpoint
  // returns the whole map; we index by workspaceId. Cheap — the map
  // stays small (~dozens of entries at scale) and the response is
  // cacheable at the browser level for the tab's lifetime.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/juliet-flags")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((map: Record<string, JulietFlag>) => {
        if (cancelled) return;
        setFlag(map[workspaceId] ?? null);
      })
      .catch(() => {
        /* silent — control remains in "not flagged" state */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function toggle(nextFlagged: boolean, withNote: string | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/juliet-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          flagged: nextFlagged,
          note: nextFlagged ? withNote ?? null : null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const map = (await res.json()) as Record<string, JulietFlag>;
      setFlag(map[workspaceId] ?? null);
      setExpanded(false);
      setNote("");
      // Refresh so the /csm Juliet-queue tab picks up the change on
      // the next server render.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-purple-200 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/10 p-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-purple-900 dark:text-purple-200">
              Juliet outreach
            </h4>
            {flag ? (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-purple-100 dark:bg-purple-500/20 border-purple-300 dark:border-purple-500/50 text-purple-900 dark:text-purple-200"
                title={
                  flag.flagged_by
                    ? `Raised ${flag.flagged_at.slice(0, 10)} by ${flag.flagged_by}`
                    : `Raised ${flag.flagged_at.slice(0, 10)}`
                }
              >
                Flagged
              </span>
            ) : null}
          </div>
          {flag?.note ? (
            <p className="mt-1 text-sm text-purple-950 dark:text-purple-100 whitespace-pre-wrap break-words">
              &ldquo;{flag.note}&rdquo;
            </p>
          ) : flag ? (
            <p className="mt-1 text-xs text-purple-800 dark:text-purple-300 italic">
              No note attached.
            </p>
          ) : (
            <p className="mt-1 text-xs text-purple-800 dark:text-purple-300">
              Raise this if you want Juliet to own the next touch on this account. Optional short note explains why.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {flag ? (
            <button
              type="button"
              onClick={() => void toggle(false, null)}
              disabled={busy}
              className="px-2 py-1 text-[11px] rounded-md font-medium border bg-surface text-fg border-border-strong hover:bg-canvas disabled:opacity-50"
            >
              {busy ? "Clearing…" : "Clear flag"}
            </button>
          ) : !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              disabled={busy}
              className="px-2 py-1 text-[11px] rounded-md font-medium border bg-purple-600 text-white border-purple-600 hover:bg-purple-700 disabled:opacity-50"
            >
              Flag for Juliet
            </button>
          ) : null}
        </div>
      </div>
      {expanded && !flag ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="Optional: what should Juliet know? (e.g., 'Yellow risk, VP asked for exec check-in')"
            className="w-full px-2 py-1.5 text-xs rounded border border-border-strong bg-surface"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void toggle(true, note.trim() || null)}
              disabled={busy}
              className="px-2 py-1 text-[11px] rounded-md font-medium border bg-purple-600 text-white border-purple-600 hover:bg-purple-700 disabled:opacity-50"
            >
              {busy ? "Raising…" : "Raise flag"}
            </button>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setNote("");
                setError(null);
              }}
              disabled={busy}
              className="px-2 py-1 text-[11px] rounded-md text-muted hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] text-red-700 dark:text-red-300">{error}</p>
      ) : null}
    </div>
  );
}
