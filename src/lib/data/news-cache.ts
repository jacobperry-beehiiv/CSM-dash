import { kvGet, kvSet } from "../storage/kv";
import type { NewsHeadline } from "../integrations/google-news";

/**
 * KV cache for per-customer Google News headlines.
 *
 * One entry per workspace, keyed `csm:news:v1:<workspace_id>`.
 * Stores the headlines plus the `fetched_at` timestamp so the
 * reader can enforce a 24h TTL on its own (the KV layer doesn't
 * auto-expire) and the UI can render a "Fetched Xh ago" chip.
 *
 * 24h TTL matches the once-a-day cron sweep cadence. News >24h old
 * is fine for "what's been happening at this customer?" — the
 * homepage feed reads exclusively from this cache (no live fetches)
 * so the 24h staleness floor only bites for the customer detail
 * panel when the cron hasn't warmed a particular workspace yet.
 */

const CACHE_KEY_PREFIX = "csm:news:v1:";
export const NEWS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface NewsCacheEntry {
  workspace_id: string;
  fetched_at: string;
  headlines: NewsHeadline[];
}

function keyFor(workspaceId: string): string {
  return `${CACHE_KEY_PREFIX}${workspaceId}`;
}

export async function loadNewsCache(
  workspaceId: string
): Promise<NewsCacheEntry | null> {
  if (!workspaceId) return null;
  return (await kvGet<NewsCacheEntry>(keyFor(workspaceId))) ?? null;
}

export async function saveNewsCache(
  workspaceId: string,
  headlines: NewsHeadline[]
): Promise<NewsCacheEntry> {
  const entry: NewsCacheEntry = {
    workspace_id: workspaceId,
    fetched_at: new Date().toISOString(),
    headlines,
  };
  await kvSet<NewsCacheEntry>(keyFor(workspaceId), entry);
  return entry;
}

/** True when the cache entry's fetched_at is older than NEWS_CACHE_TTL_MS.
 *  Returns true for missing entries too — a cold cache is by definition
 *  stale. */
export function isStale(entry: NewsCacheEntry | null): boolean {
  if (!entry) return true;
  const fetched = Date.parse(entry.fetched_at);
  if (isNaN(fetched)) return true;
  return Date.now() - fetched > NEWS_CACHE_TTL_MS;
}
