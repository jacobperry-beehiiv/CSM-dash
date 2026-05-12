"use client";

import { useState } from "react";

interface Props {
  generatedAt: string | null;
  rowCount: number | null;
}

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (isNaN(d)) return iso;
  const diffMs = Date.now() - d;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function SnapshotBanner({ generatedAt, rowCount }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "sync failed");
      // Sync runs in a GitHub Action (read-only filesystem on Vercel means
      // we can't write the snapshot in-process). Don't reload — Vercel
      // auto-redeploys when the action commits, ~2 min from now.
      setMessage(
        json.message ??
          "Sync triggered. Fresh data live in ~2 min after the deploy."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      {generatedAt ? (
        <>
          <span>
            Snapshot · {rowCount} rows · refreshed{" "}
            <span title={generatedAt}>{relativeTime(generatedAt)}</span>
          </span>
        </>
      ) : (
        <span className="text-amber-700">No snapshot — run npm run sync.</span>
      )}
      <button
        onClick={refresh}
        disabled={refreshing}
        className="px-2 py-0.5 border border-border-strong rounded hover:bg-canvas disabled:opacity-60"
        title="Triggers the sync-data GitHub Action; site auto-redeploys when it finishes."
      >
        {refreshing ? "Triggering…" : "Refresh"}
      </button>
      {message ? (
        <span className="text-emerald-700 dark:text-emerald-300">{message}</span>
      ) : null}
      {error ? <span className="text-red-600">{error}</span> : null}
    </div>
  );
}
