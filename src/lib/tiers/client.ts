"use client";

import type { EnterpriseTier } from "./store";

let cachePromise: Promise<EnterpriseTier[]> | null = null;

/**
 * Client-side ladder fetcher. Memoizes the in-flight request so multiple
 * components mounting at once share a single network round trip. Call
 * `invalidateTierCache()` after editing on /tiers to force a re-fetch.
 */
export function getTierLadder(): Promise<EnterpriseTier[]> {
  if (!cachePromise) {
    cachePromise = fetch("/api/tiers")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as EnterpriseTier[];
      })
      .catch((e) => {
        // Reset on failure so the next caller retries.
        cachePromise = null;
        throw e;
      });
  }
  return cachePromise;
}

export function invalidateTierCache() {
  cachePromise = null;
}
