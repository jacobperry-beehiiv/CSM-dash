"use client";

import { useEffect, useState } from "react";

/**
 * Per-workspace publications cache shared across the dashboard.
 *
 * The expanded company view's `CustomerPublicationsList` and the AM
 * Proactive Outreach "Copy pub IDs" bulk action both need the same
 * `{publication_id, publication_name, subscribers}` rows for a given
 * workspace. Sharing a module-level cache means:
 *
 *   - A user who expands a row then clicks Copy pub IDs gets that
 *     workspace's pubs instantly (the expand triggered the same fetch).
 *   - Repeated clicks on the same selection are free.
 *   - Concurrent callers for the same workspace_id dedupe to a single
 *     in-flight request — no duplicate Metabase queries.
 *
 * Source of truth is `/api/customers/[workspace_id]/publications`,
 * which scopes the SQL to one organization. That keeps the result set
 * well under Metabase's 2000-row /api/dataset cap that bit the
 * publications-index endpoint (paged separately in
 * /api/customers/publications-index).
 *
 * Cache lifetime: the tab session. We don't TTL because a workspace's
 * publication list rarely changes minute-to-minute, and a stale entry
 * is recovered by a page reload — same trade-off as
 * usePublicationsIndex / useStripeCustomerIndex.
 */

export interface PublicationRow {
  publication_id: string;
  publication_name: string;
  subscribers: number | null;
}

// Module-level promise cache. Storing the Promise rather than the
// resolved value gives us automatic dedup for concurrent callers (two
// rows expanding at the same instant share one in-flight request).
const CACHE = new Map<string, Promise<PublicationRow[]>>();

/**
 * Fetch publications for a single workspace, returning the cached
 * Promise on repeat calls. The Promise resolves to the same array
 * shape that `/api/customers/[workspace_id]/publications` returns.
 *
 * Failure mode: the Promise rejects with an Error. Callers should
 * `.catch` and treat the workspace as "no pubs available" rather than
 * propagating. We do NOT poison the cache on failure — that lets a
 * transient Metabase error recover on the next call rather than
 * sticking for the tab session.
 */
export function fetchPublicationsForWorkspace(
  workspaceId: string
): Promise<PublicationRow[]> {
  const cached = CACHE.get(workspaceId);
  if (cached) return cached;
  const p = fetch(
    `/api/customers/${encodeURIComponent(workspaceId)}/publications`,
    { credentials: "same-origin" }
  )
    .then(async (r) => {
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { publications: PublicationRow[] };
      return j.publications ?? [];
    })
    .catch((e) => {
      // Evict on failure so a transient error doesn't stick.
      CACHE.delete(workspaceId);
      throw e;
    });
  CACHE.set(workspaceId, p);
  return p;
}

/**
 * Declarative hook for components that render the list (the expanded
 * company view's `CustomerPublicationsList`). Wraps
 * `fetchPublicationsForWorkspace` with React state and cancel-safe
 * unmount handling.
 *
 * Returns `null` while loading, an `Error` on failure, or the array
 * on success. Discriminate via instanceof — keeps the call-site small.
 */
export function useWorkspacePublications(
  workspaceId: string
): PublicationRow[] | Error | null {
  const [state, setState] = useState<PublicationRow[] | Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    fetchPublicationsForWorkspace(workspaceId)
      .then((rows) => {
        if (!cancelled) setState(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          setState(e instanceof Error ? e : new Error(String(e)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return state;
}
