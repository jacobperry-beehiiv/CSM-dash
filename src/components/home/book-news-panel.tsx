"use client";

import { useEffect, useMemo, useState } from "react";
import { fmtDate } from "../format";
import type {
  NewsCategory,
  NewsHeadline,
} from "@/lib/integrations/google-news";

/**
 * Homepage cross-book news feed.
 *
 * Renders the latest headlines across every customer in the viewer's
 * CSM scope. Backed entirely by the per-workspace KV cache the
 * nightly news-refresh cron warms — no live RSS fetches happen on
 * home-page load.
 *
 * Filter strip: category multi-select chips (default: all on),
 * date range toggle (7d / 30d). The "scope" parameter mirrors the
 * URL ?csm= picker that other panels use, but BookNewsPanel doesn't
 * own the picker itself — it reads `csm` from the URL on mount.
 *
 * Click a customer-name link to navigate to the /am drill-down for
 * that account (closest existing surface where the detail panel
 * appears).
 */

interface BookHeadline extends NewsHeadline {
  customer: { workspace_id: string; company_name: string };
}

interface BookResponse {
  generated_at: string;
  headlines: BookHeadline[];
  workspaces_with_cache: number;
  workspaces_scanned: number;
}

const ALL_CATEGORIES: NewsCategory[] = [
  "business_structure",
  "staffing",
  "sales_funding",
];

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

const DEFAULT_VISIBLE = 20;

export function BookNewsPanel() {
  const [data, setData] = useState<BookResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategories, setActiveCategories] = useState<Set<NewsCategory>>(
    new Set(ALL_CATEGORIES)
  );
  const [days, setDays] = useState<7 | 30>(30);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Read the CSM scope from the URL so this panel matches whatever
    // the rest of the page is showing. No CSM param → team-wide.
    const params = new URLSearchParams(window.location.search);
    const csm = params.get("csm") ?? "all";
    const url = new URL("/api/news/book", window.location.origin);
    url.searchParams.set("csm", csm);
    url.searchParams.set("days", String(days));
    // Server respects the category filter, but we also re-apply
    // client-side so toggling the chips doesn't round-trip.
    fetch(url.toString())
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as BookResponse;
      })
      .then((j) => {
        if (cancelled) return;
        setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const filteredHeadlines = useMemo(() => {
    if (!data) return [];
    return data.headlines.filter((h) => activeCategories.has(h.category));
  }, [data, activeCategories]);

  const visible = showAll
    ? filteredHeadlines
    : filteredHeadlines.slice(0, DEFAULT_VISIBLE);
  const hasMore = filteredHeadlines.length > visible.length;

  function toggleCategory(c: NewsCategory) {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      // Don't allow zero categories — re-add the one being toggled
      // off so the panel never goes dark.
      if (next.size === 0) next.add(c);
      return next;
    });
  }

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-5 mt-6">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg tracking-tight">
            Recent news across your book
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Google News headlines matching your customers&rsquo; names +
            keywords for structure, staffing, and sales-and-funding
            changes. Refreshed daily at 06:00 UTC.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {ALL_CATEGORIES.map((c) => {
          const active = activeCategories.has(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggleCategory(c)}
              className={`px-2 py-1 text-[11px] font-medium rounded-md border transition ${
                active
                  ? CATEGORY_CHIP[c]
                  : "bg-canvas text-muted border-border opacity-50 hover:opacity-100"
              }`}
              title={`Show ${CATEGORY_LABEL[c]} headlines`}
            >
              {CATEGORY_LABEL[c]}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setDays(7)}
            disabled={days === 7}
            className={`px-2 py-1 border rounded-md transition ${
              days === 7
                ? "bg-accent text-accent-fg border-accent disabled:opacity-100"
                : "bg-surface border-border-strong hover:bg-canvas"
            }`}
          >
            Past 7 days
          </button>
          <button
            type="button"
            onClick={() => setDays(30)}
            disabled={days === 30}
            className={`px-2 py-1 border rounded-md transition ${
              days === 30
                ? "bg-accent text-accent-fg border-accent disabled:opacity-100"
                : "bg-surface border-border-strong hover:bg-canvas"
            }`}
          >
            Past 30 days
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted">Loading headlines…</div>
      ) : error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
          Couldn&rsquo;t load news right now: {error}
        </div>
      ) : !data ? null : data.workspaces_with_cache === 0 ? (
        <div className="text-sm text-muted">
          No cached headlines yet — the nightly refresh cron will warm
          this once it runs. Scanned {data.workspaces_scanned} workspace
          {data.workspaces_scanned === 1 ? "" : "s"} in your scope.
        </div>
      ) : filteredHeadlines.length === 0 ? (
        <div className="text-sm text-muted">
          No headlines match the current filters in the past {days} days.
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {visible.map((h) => (
              <li
                key={`${h.customer.workspace_id}::${h.url}`}
                className="flex items-start gap-3 text-sm leading-snug"
              >
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0 mt-0.5 ${CATEGORY_CHIP[h.category]}`}
                >
                  {CATEGORY_LABEL[h.category]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] text-muted">
                    <a
                      href={`/am?customer=${encodeURIComponent(h.customer.workspace_id)}`}
                      className="hover:underline font-medium text-fg"
                    >
                      {h.customer.company_name}
                    </a>{" "}
                    · {h.source} · {fmtDate(h.published_at)}
                  </span>
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-fg hover:underline break-words"
                  >
                    {h.title}
                  </a>
                </span>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-4 text-xs text-muted hover:text-fg underline"
            >
              Show {filteredHeadlines.length - visible.length} more…
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
