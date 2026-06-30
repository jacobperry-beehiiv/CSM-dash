import type { RiskFlagCode } from "../types";
import { kvGet, kvSet } from "../storage/kv";

/**
 * Store of "I've reached out about this flag" resolutions. When any CSM
 * ticks a flag as resolved, every subsequent at-risk run filters that
 * flag out for that customer until it ages out per the settings.
 */

export interface FlagResolution {
  resolved_at: string;
  resolved_by?: string | null;
  note?: string | null;
}

export type ResolutionMap = Record<string, Partial<Record<RiskFlagCode, FlagResolution>>>;

const KEY = "flag-resolutions";

/**
 * No module-level cache (same reasoning as customer-overrides.ts). On
 * Vercel's warm-isolate pool, an eternally-cached map causes resolutions
 * marked on one isolate to be invisible to other warm isolates for the
 * lifetime of the process — meaning "Mark resolved" checkboxes appeared
 * to revert when the page reloaded on a different isolate.
 */
export async function loadResolutions(): Promise<ResolutionMap> {
  return (await kvGet<ResolutionMap>(KEY)) ?? {};
}

export async function setResolution(
  workspaceId: string,
  flagCode: RiskFlagCode,
  resolved: boolean,
  meta: { resolvedBy?: string | null; note?: string | null } = {}
): Promise<ResolutionMap> {
  const map = { ...(await loadResolutions()) };
  const forWorkspace = { ...(map[workspaceId] ?? {}) };
  if (resolved) {
    forWorkspace[flagCode] = {
      resolved_at: new Date().toISOString(),
      resolved_by: meta.resolvedBy ?? null,
      note: meta.note ?? null,
    };
  } else {
    delete forWorkspace[flagCode];
  }
  if (Object.keys(forWorkspace).length === 0) {
    delete map[workspaceId];
  } else {
    map[workspaceId] = forWorkspace;
  }
  await kvSet(KEY, map);
  return map;
}

export async function isResolved(
  workspaceId: string | null | undefined,
  flagCode: RiskFlagCode
): Promise<boolean> {
  if (!workspaceId) return false;
  const map = await loadResolutions();
  return map[workspaceId]?.[flagCode] != null;
}

/**
 * Bulk-delete resolutions for a list of (workspace_id, flag_code) pairs.
 * Single KV write regardless of how many pairs are passed. Used by the
 * at-risk engine to garbage-collect resolutions whose re-raise period
 * has elapsed — so when the row resurfaces, the UI checkbox state isn't
 * stuck "checked" against a stale resolution record. Best-effort: a KV
 * write failure is logged but doesn't bubble up (the engine's read result
 * is already correct; only the next read sees the lingering record).
 *
 * Returns the number of pairs actually deleted (skips pairs that aren't
 * in the map). Idempotent — calling twice with the same input is a no-op
 * on the second call.
 */
export async function pruneResolutions(
  pairs: Array<{ workspaceId: string; flagCode: RiskFlagCode }>
): Promise<number> {
  if (pairs.length === 0) return 0;
  const map = { ...(await loadResolutions()) };
  let removed = 0;
  for (const { workspaceId, flagCode } of pairs) {
    const forWorkspace = map[workspaceId];
    if (!forWorkspace || forWorkspace[flagCode] == null) continue;
    const next = { ...forWorkspace };
    delete next[flagCode];
    removed++;
    if (Object.keys(next).length === 0) {
      delete map[workspaceId];
    } else {
      map[workspaceId] = next;
    }
  }
  if (removed === 0) return 0;
  try {
    await kvSet(KEY, map);
  } catch (e) {
    console.warn("[flag-resolutions] pruneResolutions write failed", {
      error: e instanceof Error ? e.message : String(e),
      attempted: pairs.length,
    });
  }
  return removed;
}
