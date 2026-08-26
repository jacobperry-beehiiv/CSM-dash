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
 * The cache is intentionally NOT invalidated on the settings page's
 * save — that page reloads its own state directly from the PUT
 * response, and other consumers refresh on next page load. Adding
 * cross-tab reactive invalidation isn't worth the complexity for a
 * feature CSMs touch at most a handful of times.
 *
 * Returns `null` while loading (so callers can gate a render) and
 * `{}` when there are no tags. Consumers pass the resolved map into
 * `applyMergeTags`'s `ctx.custom_tags`.
 */

let cached: Record<string, string> | null | undefined = undefined;
let pending: Promise<Record<string, string>> | null = null;

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

/** Returns null pre-resolution, then the resolved map. */
export function useCustomMergeTags(): Record<string, string> | null {
  const [map, setMap] = useState<Record<string, string> | null>(() =>
    cached ?? null
  );

  useEffect(() => {
    if (cached) {
      setMap(cached);
      return;
    }
    let cancelled = false;
    ensureCustomTags().then((m) => {
      if (!cancelled) setMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return map;
}
