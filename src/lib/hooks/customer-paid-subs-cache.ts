"use client";

import { useEffect, useState } from "react";

/**
 * Per-workspace paid-subscription summary cache. Same module-level
 * dedup/cache pattern as `customer-publications-cache` — see that
 * file's docstring for the rationale.
 *
 * Source: `/api/customers/[workspace_id]/paid-subs`, which already
 * scopes the SQL to a single organization and pre-filters tiers to
 * the cohort with at least one active subscriber.
 */

export interface TierPrice {
  price_id: string;
  amount_cents: number;
  currency: string;
  interval: string;
}

export interface TierWithSubs {
  tier_id: string;
  tier_name: string;
  publication_id: string;
  publication_name: string;
  active_subs: number;
  prices: TierPrice[];
}

export interface PaidSubsSummary {
  tiers: TierWithSubs[];
  total_active_subs: number;
  total_revenue_lifetime: number;
  publication_count: number;
}

const CACHE = new Map<string, Promise<PaidSubsSummary>>();

export function fetchPaidSubsForWorkspace(
  workspaceId: string
): Promise<PaidSubsSummary> {
  const cached = CACHE.get(workspaceId);
  if (cached) return cached;
  const p = fetch(
    `/api/customers/${encodeURIComponent(workspaceId)}/paid-subs`,
    { credentials: "same-origin" }
  )
    .then(async (r) => {
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      return (await r.json()) as PaidSubsSummary;
    })
    .catch((e) => {
      // Evict on failure so a transient Metabase glitch doesn't stick
      // for the tab session.
      CACHE.delete(workspaceId);
      throw e;
    });
  CACHE.set(workspaceId, p);
  return p;
}

export function useWorkspacePaidSubs(
  workspaceId: string
): PaidSubsSummary | Error | null {
  const [state, setState] = useState<PaidSubsSummary | Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    fetchPaidSubsForWorkspace(workspaceId)
      .then((s) => {
        if (!cancelled) setState(s);
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
