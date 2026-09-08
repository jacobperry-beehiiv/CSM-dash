"use client";

import { useEffect, useState } from "react";
import type { PerCsmMergeTag } from "./per-csm-merge-tags-types";

/**
 * Client hook for the signed-in CSM's custom merge tags.
 *
 * Fetched once per browser tab and cached module-level, same pattern
 * as useViewerEmail() in auth-client.ts — many components across the
 * template-preview tree need the same map (outreach modal, merge-tag
 * library, template editor preview), so a shared cache stops the
 * network stampede.
 *
 * The cache IS invalidated by the settings page after a successful
 * PUT — otherwise a CSM who adds a new tag, then opens the outreach
 * modal in the same tab, sees the new tag render literally as
 * `{{tag_name}}` because applyMergeTags falls through the unknown-
 * token branch (leaving the match string untouched). The settings
 * page calls `resetCustomTagsCache()` after save; other in-tab
 * consumers refetch on their next mount.
 *
 * Returns `null` while loading (so callers can gate a render) and
 * `{}` when there are no tags. Consumers pass the resolved map into
 * `applyMergeTags`'s `ctx.custom_tags`.
 */

let cached: Record<string, string> | null | undefined = undefined;
let pending: Promise<Record<string, string>> | null = null;
/** Subscribers get notified when the cache is reset — used by the
 *  hook to re-render already-mounted consumers with the fresh map
 *  instead of waiting for their next mount. Set-based so React 18's
 *  strict-mode double-mount doesn't duplicate subscriptions. */
const subscribers = new Set<() => void>();

function ensureCustomTags(): Promise<Record<string, string>> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = fetch("/api/settings/merge-tags", { cache: "no-store" })
    .then(async (r) => {
      // 401 (not signed in) — no tags. 500 — also no tags, so the
      // render path degrades to "tokens render as-is" rather than
      // crashing.
      if (!r.ok) return {};
      const j = (await r.json()) as {
        mine?: PerCsmMergeTag[];
      };
      const map: Record<string, string> = {};
      for (const t of j.mine ?? []) map[t.name] = t.value;
      return map;
    })
    .catch(() => ({}))
    .then((map) => {
      cached = map;
      pending = null;
      return map;
    });
  return pending;
}

/** Clear the module cache so the next `ensureCustomTags()` call re-
 *  fetches, and poke every mounted subscriber to update. Called from
 *  the settings page after a successful save so the outreach modal
 *  and template editor in the same tab pick up the new tags without
 *  a reload. Idempotent — safe to call when nothing was cached. */
export function resetCustomTagsCache(): void {
  cached = undefined;
  pending = null;
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      // A subscriber's re-fetch throwing shouldn't cascade — the
      // hook wraps its own errors, this catch is belt-and-suspenders.
    }
  }
}

/** Returns null pre-resolution, then the resolved map. Subscribes to
 *  cache resets so a settings-page save in the same tab updates
 *  already-mounted consumers without a page reload. */
export function useCustomMergeTags(): Record<string, string> | null {
  const [map, setMap] = useState<Record<string, string> | null>(() =>
    cached ?? null
  );

  useEffect(() => {
    let cancelled = false;
    // Re-fetch on both initial mount (when nothing's cached yet) and
    // whenever the module-level cache is reset. Setting cached to
    // whatever comes back is safe — ensureCustomTags rebuilds it on
    // its own after invalidation.
    const refetch = () => {
      ensureCustomTags().then((m) => {
        if (!cancelled) setMap(m);
      });
    };
    if (cached) {
      setMap(cached);
    } else {
      refetch();
    }
    subscribers.add(refetch);
    return () => {
      cancelled = true;
      subscribers.delete(refetch);
    };
  }, []);

  return map;
}
