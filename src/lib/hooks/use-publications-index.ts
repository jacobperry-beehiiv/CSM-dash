"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Lazily-loaded `publication_id → workspace_id` map for the dashboard's
 * search inputs. A CSM/AM frequently has just a publication ID on hand
 * (from Beehiiv admin, a Slack support thread, a Stripe metadata
 * field) and wants to find which customer in the book owns it. This
 * hook fetches the index once per tab session, dedupes concurrent
 * callers (multiple panels mount at once on /am), and serves a stable
 * memoized `ws → pubs[]` reverse-map so search predicates don't
 * recompute it per keystroke.
 *
 * Failure mode: silently returns empty maps. The search field then
 * falls back to its pre-existing behavior (name/email/Stripe ID), so
 * publication-ID lookup degrading is invisible to the user — they
 * just won't get the new affordance.
 */

interface IndexShape {
  pub2ws: Record<string, string>;
}

// Module-level cache so the second panel on the page doesn't refetch.
// Cleared on a hard reload — which is the right TTL for this data,
// since `/api/customers/publications-index` itself ships a 5-minute
// HTTP cache header.
let CACHE: IndexShape | null = null;
let IN_FLIGHT: Promise<IndexShape> | null = null;

async function fetchOnce(): Promise<IndexShape> {
  if (CACHE) return CACHE;
  if (IN_FLIGHT) return IN_FLIGHT;
  IN_FLIGHT = fetch("/api/customers/publications-index", {
    credentials: "same-origin",
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as IndexShape;
      const safe: IndexShape = { pub2ws: j.pub2ws ?? {} };
      CACHE = safe;
      return safe;
    })
    .catch(() => {
      // Soft-fail: stash an empty map so downstream panels behave the
      // same as a logged-out viewer and we don't re-hammer the
      // endpoint after a transient failure.
      const empty: IndexShape = { pub2ws: {} };
      CACHE = empty;
      return empty;
    })
    .finally(() => {
      IN_FLIGHT = null;
    });
  return IN_FLIGHT;
}

export interface PublicationsIndex {
  /** publication_id → workspace_id (organization_id). */
  pub2ws: Record<string, string>;
  /** workspace_id → publication_id[]. Derived once per pub2ws change.
   *  Empty array when a workspace has no publications. */
  ws2pubs: Record<string, string[]>;
  /** True once the initial fetch has resolved (success or empty). */
  ready: boolean;
}

const EMPTY: PublicationsIndex = {
  pub2ws: {},
  ws2pubs: {},
  ready: false,
};

export function usePublicationsIndex(): PublicationsIndex {
  const [data, setData] = useState<IndexShape | null>(CACHE);

  useEffect(() => {
    let cancelled = false;
    void fetchOnce().then((next) => {
      if (!cancelled) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo<PublicationsIndex>(() => {
    if (!data) return EMPTY;
    const ws2pubs: Record<string, string[]> = {};
    for (const [pub, ws] of Object.entries(data.pub2ws)) {
      (ws2pubs[ws] ??= []).push(pub);
    }
    return {
      pub2ws: data.pub2ws,
      ws2pubs,
      ready: true,
    };
  }, [data]);
}
