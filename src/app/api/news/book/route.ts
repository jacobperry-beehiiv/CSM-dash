import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { filterCustomers, loadCustomers } from "@/lib/data/load-customers";
import { loadNewsCache } from "@/lib/data/news-cache";
import {
  dismissalKey,
  loadDismissedKeySet,
} from "@/lib/data/news-dismissals";
import type { NewsCategory, NewsHeadline } from "@/lib/integrations/google-news";
import type { Segment } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/news/book
 *   ?csm=<handle> | "all" (default "all" — team-wide view)
 *   ?days=7|30   (default 30)
 *   ?categories=business_structure,staffing,sales_funding (default all)
 *
 * Aggregates the KV cache across every workspace in the viewer's
 * CSM scope. Returns one flat list of `{ ...NewsHeadline, customer }`
 * sorted by published_at desc. Backed entirely by the nightly cron's
 * cache — no live RSS fetches happen here, so this route is fast
 * regardless of book size.
 *
 * Auth: signed-in session only.
 */

interface BookHeadline extends NewsHeadline {
  customer: { workspace_id: string; company_name: string };
}

interface BookNewsResponse {
  generated_at: string;
  headlines: BookHeadline[];
  /** Workspaces with at least one entry in cache — useful for the UI
   *  to distinguish "no news" from "cache cold for everyone." */
  workspaces_with_cache: number;
  workspaces_scanned: number;
}

const ALL_CATEGORIES: NewsCategory[] = [
  "business_structure",
  "staffing",
  "sales_funding",
];

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  const url = new URL(req.url);
  const csmParam = url.searchParams.get("csm");
  const csm = csmParam && csmParam !== "all" ? csmParam : null;
  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days =
    Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 30;
  // Segment filter — "enterprise" / "growth" / "all" (default). Used
  // by the panel's "All ENT" scope toggle. Validation: anything other
  // than the three known values falls back to "all" so a bogus URL
  // param can't break the panel.
  const segmentParam = (url.searchParams.get("segment") ?? "all").trim();
  const segment: Segment =
    segmentParam === "enterprise" || segmentParam === "growth"
      ? segmentParam
      : "all";
  const categoryParam = url.searchParams.get("categories");
  const wantedCategories = categoryParam
    ? new Set(
        categoryParam
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is NewsCategory =>
            ALL_CATEGORIES.includes(s as NewsCategory)
          )
      )
    : new Set(ALL_CATEGORIES);

  try {
    const all = await loadCustomers();
    const scoped = filterCustomers(all, { csm, segment });
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    // Batch parallel-read the cache for every workspace in scope.
    // Each KV read is small; with a managed Postgres backend this
    // is one round-trip per workspace, which we accept for the
    // simplicity of not adding a batched-get helper. Wall-clock for
    // a 150-customer book is well under a second.
    const entries = await Promise.all(
      scoped
        .filter((c) => Boolean(c.workspace_id))
        .map((c) =>
          loadNewsCache(c.workspace_id as string).then((entry) => ({
            customer: {
              workspace_id: c.workspace_id as string,
              company_name:
                c.company_name?.trim() ||
                c.workspace_name?.trim() ||
                "Unknown",
            },
            entry,
          }))
        )
    );

    // Dismissed (workspace, url) pairs hidden globally — every CSM
    // benefits when one of them flags an off-topic match.
    const dismissed = await loadDismissedKeySet();
    let withCache = 0;
    const out: BookHeadline[] = [];
    for (const { customer, entry } of entries) {
      if (!entry) continue;
      withCache++;
      for (const h of entry.headlines) {
        if (!wantedCategories.has(h.category)) continue;
        const ts = Date.parse(h.published_at);
        if (isNaN(ts) || ts < cutoff) continue;
        if (dismissed.has(dismissalKey(customer.workspace_id, h.url))) continue;
        out.push({ ...h, customer });
      }
    }
    out.sort((a, b) =>
      a.published_at < b.published_at
        ? 1
        : a.published_at > b.published_at
          ? -1
          : 0
    );

    const response: BookNewsResponse = {
      generated_at: new Date().toISOString(),
      headlines: out,
      workspaces_with_cache: withCache,
      workspaces_scanned: scoped.length,
    };
    return NextResponse.json(response);
  } catch (e) {
    console.error("[news/book] 500", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
