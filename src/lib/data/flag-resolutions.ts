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

let memCache: ResolutionMap | null = null;

export async function loadResolutions(): Promise<ResolutionMap> {
  if (memCache) return memCache;
  memCache = (await kvGet<ResolutionMap>(KEY)) ?? {};
  return memCache;
}

async function persist(map: ResolutionMap) {
  await kvSet(KEY, map);
  memCache = map;
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
  await persist(map);
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
