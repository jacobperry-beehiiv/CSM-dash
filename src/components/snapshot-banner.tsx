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
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "sync failed");
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
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
      >
        {refreshing ? "Refreshing… (~60s)" : "Refresh"}
      </button>
      {error ? <span className="text-red-600">{error}</span> : null}
    </div>
  );
}
