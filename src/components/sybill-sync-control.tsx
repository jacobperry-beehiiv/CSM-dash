"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client island for /settings/sybill. Renders:
 *
 *   • a single primary "Sync action items" button
 *   • last-sync summary line
 *   • collapsible recent-runs activity log
 *
 * Everything heavy lives behind /api/csm/sybill/sync. The GET on
 * the same endpoint surfaces the current state at mount; the POST
 * runs a sweep and returns the fresh state inline.
 */

interface SybillRunRecord {
  ran_at: string;
  messages_scanned: number;
  messages_skipped_already_processed: number;
  messages_no_action_items: number;
  todos_created: number;
  errors: string[];
}

interface GetResponse {
  last_sync_at: string | null;
  recent_runs: SybillRunRecord[];
  processed_count: number;
}

interface PostResponse {
  ok: boolean;
  ran_at: string;
  scanned: number;
  todos_created: number;
  skipped_already_processed: number;
  skipped_no_action_items: number;
  errors: string[];
  last_sync_at?: string;
  recent_runs: SybillRunRecord[];
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function SybillSyncControl() {
  const router = useRouter();
  const [state, setState] = useState<GetResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<PostResponse | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/csm/sybill/sync", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState((await r.json()) as GetResponse);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runSync(): Promise<void> {
    setSyncing(true);
    setLastResult(null);
    try {
      const r = await fetch("/api/csm/sybill/sync", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as PostResponse & {
        error?: string;
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setLastResult(j);
      // Pull fresh GET state so the summary + activity log match what
      // the POST returned (cheaper than threading the same fields
      // through both code paths).
      await refresh();
      // Bust the dashboard's server cache so the personal-todos
      // panel renders the new rows on next navigation.
      router.refresh();
    } catch (e) {
      setLastResult({
        ok: false,
        ran_at: new Date().toISOString(),
        scanned: 0,
        todos_created: 0,
        skipped_already_processed: 0,
        skipped_no_action_items: 0,
        errors: [e instanceof Error ? e.message : "Sync failed"],
        recent_runs: [],
      });
    } finally {
      setSyncing(false);
    }
  }

  const recentRuns = state?.recent_runs ?? [];
  const lastRun = recentRuns[0];

  return (
    <div className="space-y-4">
      <div className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <button
          type="button"
          onClick={() => void runSync()}
          disabled={syncing}
          className="px-4 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "↻ Sync action items from Sybill"}
        </button>
        <div className="text-xs text-muted">
          Last sync: <strong>{fmtRelative(state?.last_sync_at ?? null)}</strong>
          {lastRun ? (
            <>
              {" "}— created <strong>{lastRun.todos_created}</strong>{" "}
              to-do{lastRun.todos_created === 1 ? "" : "s"} from{" "}
              <strong>{lastRun.messages_scanned}</strong> recap
              {lastRun.messages_scanned === 1 ? "" : "s"}
              {lastRun.messages_skipped_already_processed > 0 ? (
                <>
                  {" "}({lastRun.messages_skipped_already_processed} already
                  processed)
                </>
              ) : null}
              .
            </>
          ) : null}
        </div>

        {lastResult ? (
          <div
            className={`text-xs rounded-md p-2 border ${
              lastResult.ok && lastResult.errors.length === 0
                ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-900 dark:text-emerald-200"
                : "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900 dark:text-amber-200"
            }`}
          >
            <strong>
              {lastResult.todos_created} to-do
              {lastResult.todos_created === 1 ? "" : "s"} added.
            </strong>{" "}
            Scanned {lastResult.scanned} recap
            {lastResult.scanned === 1 ? "" : "s"};{" "}
            {lastResult.skipped_already_processed} already processed;{" "}
            {lastResult.skipped_no_action_items} had no Action Items section.
            {lastResult.errors.length > 0 ? (
              <ul className="mt-1 list-disc pl-4 break-words">
                {lastResult.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {loadError ? (
          <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-2">
            Couldn&rsquo;t load activity: {loadError}
          </div>
        ) : null}
      </div>

      <div className="bg-surface rounded-xl border border-border shadow-card p-4">
        <button
          type="button"
          onClick={() => setActivityOpen((v) => !v)}
          className="text-sm font-medium text-fg hover:underline w-full text-left flex items-center justify-between"
        >
          <span>Recent activity ({recentRuns.length})</span>
          <span className="text-xs text-muted">
            {activityOpen ? "Hide" : "Show"}
          </span>
        </button>
        {activityOpen ? (
          recentRuns.length === 0 ? (
            <p className="text-xs text-muted mt-2">
              No sync history yet. Click the button above to run your first
              sweep.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border/60 text-xs">
              {recentRuns.map((r, i) => (
                <li key={i} className="py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-muted">
                      {fmtRelative(r.ran_at)}
                    </span>
                    <span className="text-fg">
                      <strong>{r.todos_created}</strong> created ·{" "}
                      {r.messages_scanned} scanned ·{" "}
                      {r.messages_skipped_already_processed} skipped ·{" "}
                      {r.messages_no_action_items} no-items
                    </span>
                  </div>
                  {r.errors.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4 text-red-700 dark:text-red-300">
                      {r.errors.map((err, j) => (
                        <li key={j}>{err}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}
