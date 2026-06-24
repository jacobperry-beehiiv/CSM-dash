"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

/** Three-way scope filter that overrides the URL-driven CSM scope at
 *  the panel level. Picking "mine" forces ?csm=<viewer's handle>;
 *  "ent" forces segment=enterprise + ?csm=all; "everyone" drops both
 *  filters. Default lands on "mine" when the viewer has a CSM handle,
 *  else "everyone" (an admin who isn't a CSM shouldn't open the
 *  panel and see only their own zero-account book). */
type Scope = "mine" | "ent" | "everyone";

interface BookNewsPanelProps {
  /** The signed-in viewer's CSM handle (e.g. "Jacob_Perry"), or null
   *  when we can't match them in the customer book. Resolved server-
   *  side on the home page so the panel doesn't have to refetch. */
  viewerCsmHandle?: string | null;
}

export function BookNewsPanel({ viewerCsmHandle = null }: BookNewsPanelProps) {
  const [data, setData] = useState<BookResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategories, setActiveCategories] = useState<Set<NewsCategory>>(
    new Set(ALL_CATEGORIES)
  );
  const [days, setDays] = useState<7 | 30>(30);
  const [showAll, setShowAll] = useState(false);
  // Default scope = "mine" when we have a handle to scope to; falls
  // back to "everyone" otherwise. CSM-team admins / non-CSM viewers
  // get a meaningful first render under the fallback.
  const [scope, setScope] = useState<Scope>(
    viewerCsmHandle ? "mine" : "everyone"
  );
  // Refresh-now state. The sweep is multi-second (~30-60s for a
  // 150-customer book even when scoped to one CSM); the button shows
  // "Refreshing…" + a hint about expected time so it doesn't read
  // as stuck. `refreshMessage` carries the post-run summary so the
  // CSM can see what landed.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  /** Stamp the right `csm` + `segment` query params on a URL based
   *  on the active scope. Shared by the fetch + refresh paths so the
   *  two stay in lock-step. */
  const applyScope = useCallback(
    (url: URL): void => {
      if (scope === "mine" && viewerCsmHandle) {
        url.searchParams.set("csm", viewerCsmHandle);
      } else if (scope === "ent") {
        url.searchParams.set("csm", "all");
        url.searchParams.set("segment", "enterprise");
      } else {
        url.searchParams.set("csm", "all");
      }
    },
    [scope, viewerCsmHandle]
  );

  /** Fetch /api/news/book for the active scope + days filter. Used
   *  both on mount and after a successful Refresh-now so the freshly-
   *  warmed cache shows up immediately. */
  const fetchBook = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/news/book", window.location.origin);
      applyScope(url);
      url.searchParams.set("days", String(days));
      const r = await fetch(url.toString());
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as BookResponse;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown");
    } finally {
      setLoading(false);
    }
  }, [days, applyScope]);

  useEffect(() => {
    let cancelled = false;
    void fetchBook().catch(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [fetchBook]);

  /** POST /api/news/sweep with the active scope params, then re-fetch
   *  the book aggregator so the new headlines show up without a page
   *  reload. The sweep is scoped exactly the same way the panel's
   *  current filter is (so toggling to "All ENT" then hitting
   *  Refresh refreshes every Enterprise account team-wide; toggling
   *  to "My book" refreshes just the viewer's customers). */
  async function refreshNow() {
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const url = new URL("/api/news/sweep", window.location.origin);
      applyScope(url);
      const r = await fetch(url.toString(), { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        processed?: number;
        succeeded?: number;
        failed?: number;
        with_headlines?: number;
        total_headlines?: number;
        error?: string;
      };
      if (!r.ok || j.ok === false) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const parts: string[] = [];
      parts.push(`${j.succeeded ?? 0}/${j.processed ?? 0} customers refreshed`);
      if ((j.with_headlines ?? 0) > 0) {
        parts.push(`${j.with_headlines} with new headlines`);
      }
      if ((j.failed ?? 0) > 0) {
        parts.push(`${j.failed} failed`);
      }
      setRefreshMessage(parts.join(" · "));
      // Re-fetch so the panel reflects the freshly-warmed cache.
      await fetchBook();
    } catch (e) {
      setRefreshMessage(
        `Refresh failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setRefreshing(false);
    }
  }

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
        <button
          type="button"
          onClick={() => void refreshNow()}
          disabled={refreshing || loading}
          className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas disabled:opacity-50 flex-shrink-0"
          title="Re-pull Google News for every customer in your current CSM scope. Takes about a minute."
        >
          {refreshing ? "Refreshing… (~60s)" : "↻ Refresh now"}
        </button>
      </div>
      {refreshMessage ? (
        <div className="mb-3 text-xs text-muted">{refreshMessage}</div>
      ) : null}

      {/* Scope segmented control — overrides the URL-driven CSM
       *  scope at the panel level so a CSM viewing /am with their
       *  own ?csm= filter can still pivot the news feed to "All
       *  ENT" without changing the rest of the page. */}
      <div
        className="inline-flex items-center rounded-md border border-border-strong overflow-hidden mb-3"
        role="tablist"
        aria-label="News feed scope"
      >
        <ScopeButton
          label="My book"
          active={scope === "mine"}
          disabled={!viewerCsmHandle}
          onClick={() => setScope("mine")}
          title={
            viewerCsmHandle
              ? `Customers assigned to ${viewerCsmHandle.replace(/_/g, " ")}`
              : "No CSM handle resolved for your account — pick another scope"
          }
        />
        <ScopeButton
          label="All ENT"
          active={scope === "ent"}
          onClick={() => setScope("ent")}
          title="Every Enterprise customer across the team"
        />
        <ScopeButton
          label="Everyone"
          active={scope === "everyone"}
          onClick={() => setScope("everyone")}
          title="Every customer in the book"
        />
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

function ScopeButton({
  label,
  active,
  disabled,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`px-3 py-1 text-xs transition border-r border-border-strong last:border-r-0 ${
        active
          ? "bg-accent text-accent-fg"
          : "bg-surface text-fg hover:bg-canvas"
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}
