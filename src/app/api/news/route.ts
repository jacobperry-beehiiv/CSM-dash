import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import { fetchNewsForCompany } from "@/lib/integrations/google-news";
import {
  isStale,
  loadNewsCache,
  saveNewsCache,
  type NewsCacheEntry,
} from "@/lib/data/news-cache";
import {
  dismissalKey,
  loadDismissedKeySet,
} from "@/lib/data/news-dismissals";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/news?workspace_id=<id>&refresh=0|1
 *
 * Returns the cached news headlines for a workspace. On cold cache
 * (or `?refresh=1`), fires the three Google News RSS queries
 * synchronously and writes the result. Reads-from-cache typically
 * resolve in <50ms; live fetches take 1-3s depending on Google's
 * mood. Soft-fails — if the fetch returns nothing the entry still
 * gets cached as `{ headlines: [] }` so the next 24h of requests
 * don't re-hammer Google for a customer that has no recent news.
 *
 * Auth: signed-in session only.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspace_id") ?? "").trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  const forceRefresh = url.searchParams.get("refresh") === "1";

  try {
    let entry = await loadNewsCache(workspaceId);
    const dismissed = await loadDismissedKeySet();
    if (!forceRefresh && entry && !isStale(entry)) {
      return NextResponse.json(filterDismissed(entry, workspaceId, dismissed));
    }

    // Cold or stale or explicitly refreshed. Resolve the company
    // name from the customer book — the news fetcher needs the
    // human-readable name, not the workspace UUID.
    const customers = await loadCustomers();
    const customer = customers.find((c) => c.workspace_id === workspaceId);
    const companyName =
      customer?.company_name?.trim() ||
      customer?.workspace_name?.trim() ||
      "";
    if (!companyName) {
      // No name to query — return whatever's in cache (even stale)
      // so the panel can at least show a "no name resolved" empty
      // state without thrashing.
      return NextResponse.json(
        entry ?? {
          workspace_id: workspaceId,
          fetched_at: new Date().toISOString(),
          headlines: [],
        }
      );
    }

    const headlines = await fetchNewsForCompany(companyName);
    entry = await saveNewsCache(workspaceId, headlines);
    return NextResponse.json(filterDismissed(entry, workspaceId, dismissed));
  } catch (e) {
    console.error("[news] route failed", { workspaceId, error: e });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/** Drop any headline whose (workspace_id, url) is in the dismissals
 *  set. Preserves all other entry fields so the panel can still show
 *  the `fetched_at` chip. */
function filterDismissed(
  entry: NewsCacheEntry,
  workspaceId: string,
  dismissed: Set<string>
): NewsCacheEntry {
  if (dismissed.size === 0) return entry;
  const headlines = entry.headlines.filter(
    (h) => !dismissed.has(dismissalKey(workspaceId, h.url))
  );
  if (headlines.length === entry.headlines.length) return entry;
  return { ...entry, headlines };
}
