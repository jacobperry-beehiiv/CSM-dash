import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-post deliverability "clear" resolutions. A CSM can mark any
 * flagged send as cleared (acknowledged / triaged / known-noise) and
 * the row stops showing in the active alerts list. Mirrors the
 * flag-resolutions pattern used by the at-risk engine but is keyed
 * by post_id (per-send) rather than workspace_id + flag_code, because
 * the resolution is about "I've looked at this specific send" — not
 * about silencing a flag class for the workspace.
 *
 * No auto-expiry: a cleared post stays cleared forever. The next send
 * from the same publication is a different post_id and trips the
 * flags fresh.
 */

export interface DeliverabilityClear {
  cleared_at: string;
  cleared_by?: string | null;
  reason?: string | null;
}

export type DeliverabilityClearMap = Record<string, DeliverabilityClear>;

const KEY = "deliverability-clears";

/** No module-level cache — same reasoning as flag-resolutions: warm
 *  isolates would otherwise show stale "uncleared" rows after one
 *  isolate writes a clear. */
export async function loadClearedPosts(): Promise<DeliverabilityClearMap> {
  return (await kvGet<DeliverabilityClearMap>(KEY)) ?? {};
}

export async function clearPost(
  postId: string,
  meta: { clearedBy?: string | null; reason?: string | null } = {}
): Promise<DeliverabilityClearMap> {
  const map = { ...(await loadClearedPosts()) };
  map[postId] = {
    cleared_at: new Date().toISOString(),
    cleared_by: meta.clearedBy ?? null,
    reason: meta.reason ?? null,
  };
  await kvSet(KEY, map);
  return map;
}

export async function unclearPost(
  postId: string
): Promise<DeliverabilityClearMap> {
  const map = { ...(await loadClearedPosts()) };
  delete map[postId];
  await kvSet(KEY, map);
  return map;
}
