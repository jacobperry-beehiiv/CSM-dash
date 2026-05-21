import { kvGet, kvSet } from "../storage/kv";
import {
  MAX_STORED_UPDATES,
  type FeatureUpdate,
  type FeatureUpdatesStore,
} from "./types";

/**
 * KV-backed read/write for the synced feature-update feed. Reads always
 * hit the store fresh (no module cache) so a manual "sync now" from one
 * isolate is visible to the next request from another isolate.
 */

const KEY = "csm:feature-updates:v1";

const EMPTY: FeatureUpdatesStore = {
  updates: [],
  last_synced_at: null,
  cursor_ts: null,
};

export async function getFeatureUpdates(): Promise<FeatureUpdatesStore> {
  const stored = await kvGet<Partial<FeatureUpdatesStore>>(KEY);
  if (!stored) return EMPTY;
  return {
    updates: Array.isArray(stored.updates) ? stored.updates : [],
    last_synced_at: stored.last_synced_at ?? null,
    cursor_ts: stored.cursor_ts ?? null,
  };
}

/** Merge a batch of freshly-fetched messages with whatever is already
 *  stored, dedupe by `id` (Slack ts), keep newest first, cap to the
 *  rolling window, and persist. Returns counts so the sync route can
 *  report how many new items landed. */
export async function mergeFeatureUpdates(args: {
  incoming: FeatureUpdate[];
  cursor_ts: string | null;
}): Promise<{ added: number; total: number }> {
  const current = await getFeatureUpdates();
  const seen = new Set(current.updates.map((u) => u.id));
  const added: FeatureUpdate[] = [];
  for (const item of args.incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    added.push(item);
  }
  const merged = [...added, ...current.updates]
    .sort((a, b) => b.posted_at_ms - a.posted_at_ms)
    .slice(0, MAX_STORED_UPDATES);

  // Cursor: newest ts we've seen, regardless of whether it came from
  // this batch or the existing store. Falling back to the existing
  // cursor handles the case where Slack returned zero messages but we
  // already had one stored.
  const newestTs =
    merged[0]?.id ?? args.cursor_ts ?? current.cursor_ts ?? null;

  const next: FeatureUpdatesStore = {
    updates: merged,
    last_synced_at: new Date().toISOString(),
    cursor_ts: newestTs,
  };
  await kvSet(KEY, next);
  return { added: added.length, total: merged.length };
}
