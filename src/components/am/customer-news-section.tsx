"use client";

import { useCallback, useEffect, useState } from "react";
import { CollapsibleSection } from "../collapsible-section";
import { fmtDate } from "../format";
import type {
  NewsCategory,
  NewsHeadline,
} from "@/lib/integrations/google-news";

/**
 * "Recent news" section in the expanded customer detail panel.
 *
 * Lazy-loads from /api/news?workspace_id=... on first mount. Each
 * headline rendered as a color-coded chip + link. Manual Refresh
 * button busts the 24h cache and force-fetches.
 *
 * Soft-fails on any non-200 — surfaces a muted "Couldn't load
 * news right now" line so the rest of the detail panel keeps
 * working. Common-name false positives (e.g. customer named
 * "Target") are an unavoidable signal-noise tradeoff for v1;
 * follow-up is a per-customer mute toggle.
 */

interface Props {
  workspaceId: string;
}

interface NewsResponse {
  workspace_id: string;
  fetched_at: string;
  headlines: NewsHeadline[];
}

const CATEGORY_LABEL: Record<NewsCategory, string> = {
  business_structure: "Structure",
  staffing: "Staffing",
  sales_funding: "Sales",
};

const CATEGORY_CHIP: Record<NewsCategory, string> = {
  business_structure:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200 border-indigo-200 dark:border-indigo-500/40",
  staffing:
    "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200 border-amber-200 dark:border-amber-500/40",
  sales_funding:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/40",
};

export function CustomerNewsSection({ workspaceId }: Props) {
  const [data, setData] = useState<NewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (force) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/news", window.location.origin);
        url.searchParams.set("workspace_id", workspaceId);
        if (force) url.searchParams.set("refresh", "1");
        const r = await fetch(url.toString());
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        const j = (await r.json()) as NewsResponse;
        setData(j);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load(false).catch(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const headlineCount = data?.headlines.length ?? 0;
  const trailing = loading ? (
    <span className="text-[10px] text-subtle">Loading…</span>
  ) : error ? (
    <span className="text-[10px] text-red-700 dark:text-red-300">error</span>
  ) : (
    <span className="text-[10px] text-subtle">
      {headlineCount} headline{headlineCount === 1 ? "" : "s"} ·{" "}
      {data?.fetched_at ? `fetched ${fmtDate(data.fetched_at)}` : "—"}
    </span>
  );

  return (
    <CollapsibleSection title="Recent news" trailing={trailing}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted max-w-prose">
            Headlines from Google News matching this customer&rsquo;s name +
            keywords for business-structure, staffing, and sales/funding
            changes. Last 30 days. Best-effort — some matches will be
            false positives for common names.
          </p>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing || loading}
            className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
            title="Force a live fetch, bypassing the 24h cache"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {loading ? (
          <div className="text-xs text-muted">Loading headlines…</div>
        ) : error ? (
          <div className="text-xs text-muted">
            Couldn&rsquo;t load news right now — try again in a few minutes.
          </div>
        ) : headlineCount === 0 ? (
          <div className="text-xs text-muted">
            No relevant headlines in the last 30 days.
          </div>
        ) : (
          <ul className="space-y-2">
            {data!.headlines.map((h) => (
              <li
                key={h.url}
                className="flex items-start gap-2 text-sm leading-snug"
              >
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0 mt-0.5 ${CATEGORY_CHIP[h.category]}`}
                >
                  {CATEGORY_LABEL[h.category]}
                </span>
                <span className="min-w-0 flex-1">
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-fg hover:underline break-words"
                  >
                    {h.title}
                  </a>
                  <span className="block text-[11px] text-muted">
                    {h.source} · {fmtDate(h.published_at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </CollapsibleSection>
  );
}
