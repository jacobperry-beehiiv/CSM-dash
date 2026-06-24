import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-(workspace, URL) news headline dismissals.
 *
 * A CSM can mark any headline as "not related to this customer"
 * and it stops showing in both the customer detail panel and the
 * cross-book homepage feed. Same `csm:news:dismissed:v1` map across
 * all viewers — "this story isn't about this customer" is an
 * objective signal that every CSM benefits from, so dismissals
 * are global rather than per-user.
 *
 * Key format: `${workspace_id}::${url}`. Scoping by workspace
 * matters because two customers can legitimately share a URL
 * (rare but possible — e.g. both mentioned in one industry round-up
 * piece). Dismissing for customer A shouldn't hide it for B.
 *
 * The dismissal layer filters at READ time in the API routes; the
 * KV news cache itself is left alone. Next sweep may re-fetch the
 * same URL from Google News, but the read filter keeps it hidden.
 */

export interface NewsDismissal {
  workspace_id: string;
  url: string;
  /** Snapshot of the title at dismiss time. Useful for an "undo"
   *  list UI without joining back against the (possibly evicted)
   *  cache. */
  title?: string | null;
  dismissed_at: string;
  dismissed_by?: string | null;
}

export type NewsDismissalMap = Record<string, NewsDismissal>;

const KEY = "csm:news:dismissed:v1";

/** Stable composite key. Both sides URL-encoded for safety even
 *  though workspace_ids are UUIDs in practice. */
export function dismissalKey(workspaceId: string, url: string): string {
  return `${workspaceId}::${url}`;
}

export async function loadDismissedNews(): Promise<NewsDismissalMap> {
  return (await kvGet<NewsDismissalMap>(KEY)) ?? {};
}

/** Build a Set of dismissal keys for cheap O(1) filtering at read
 *  time. Cheaper than passing the whole map around when the only
 *  question the readers ask is "is this (workspace, url) dismissed?". */
export async function loadDismissedKeySet(): Promise<Set<string>> {
  const map = await loadDismissedNews();
  return new Set(Object.keys(map));
}

export async function dismissHeadline(
  workspaceId: string,
  url: string,
  meta: { title?: string | null; dismissedBy?: string | null } = {}
): Promise<NewsDismissalMap> {
  const map = { ...(await loadDismissedNews()) };
  const k = dismissalKey(workspaceId, url);
  map[k] = {
    workspace_id: workspaceId,
    url,
    title: meta.title ?? null,
    dismissed_at: new Date().toISOString(),
    dismissed_by: meta.dismissedBy ?? null,
  };
  await kvSet(KEY, map);
  return map;
}

export async function undismissHeadline(
  workspaceId: string,
  url: string
): Promise<NewsDismissalMap> {
  const map = { ...(await loadDismissedNews()) };
  delete map[dismissalKey(workspaceId, url)];
  await kvSet(KEY, map);
  return map;
}

/** Filter a list of dismissals down to one workspace's. Used by
 *  the per-customer panel's "Show hidden" toggle to surface only
 *  the relevant restore candidates. */
export function dismissalsForWorkspace(
  map: NewsDismissalMap,
  workspaceId: string
): NewsDismissal[] {
  return Object.values(map).filter((d) => d.workspace_id === workspaceId);
}
