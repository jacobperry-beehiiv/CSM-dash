"use client";

import { useEffect, useState } from "react";
import type { ZendeskBlob, ZendeskSummary } from "./zendesk-tickets";

/**
 * Client hook for the shared Zendesk-tickets overlay.
 *
 * Same pattern as [[use-custom-merge-tags]] — fetched once per browser
 * tab and cached module-level so opening five customer profiles in a
 * row costs one round-trip. Returns `null` while loading and an empty
 * blob on network failure (so consumers can gate on `.rows[id]` and
 * degrade gracefully instead of showing an error where a chip should be).
 */

const EMPTY: ZendeskBlob = {
  rows: {},
  fetched_at: new Date(0).toISOString(),
  lookback_days: 30,
};

let cached: ZendeskBlob | undefined = undefined;
let pending: Promise<ZendeskBlob> | null = null;

function ensureOverlay(): Promise<ZendeskBlob> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = fetch("/api/zendesk-tickets", { cache: "no-store" })
    .then(async (r) => {
      if (!r.ok) return EMPTY;
      return (await r.json()) as ZendeskBlob;
    })
    .catch(() => EMPTY)
    .then((blob) => {
      cached = blob;
      pending = null;
      return blob;
    });
  return pending;
}

/** Returns null until the fetch resolves, then the whole overlay. */
export function useZendeskOverlay(): ZendeskBlob | null {
  const [blob, setBlob] = useState<ZendeskBlob | null>(() => cached ?? null);

  useEffect(() => {
    if (cached) {
      setBlob(cached);
      return;
    }
    let cancelled = false;
    ensureOverlay().then((b) => {
      if (!cancelled) setBlob(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return blob;
}

/** Convenience — look up a single workspace's summary. Returns null
 *  while loading, then either the row or null when the workspace
 *  isn't in the overlay (not scanned yet). */
export function useZendeskSummary(
  workspaceId: string | null | undefined
): ZendeskSummary | null {
  const blob = useZendeskOverlay();
  if (!blob) return null;
  if (!workspaceId) return null;
  return blob.rows[workspaceId] ?? null;
}
