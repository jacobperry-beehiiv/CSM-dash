import { kvGet, kvSet } from "../storage/kv";
import type { WinsConfig } from "./wins-config-types";
import {
  DEFAULT_WINS_CONFIG,
  mergeWinsConfig,
} from "./wins-config-types";

/**
 * Server-only KV store for admin overrides of the Wins & Opportunities
 * rule thresholds. The wins detection engine calls `loadWinsConfig()`
 * once per run, then hands the merged blob down to each rule.
 *
 * Same posture as flag-resolutions / wins-store: no module-level
 * cache — Vercel warm-isolate pool + stale-cache would let one
 * isolate score against thresholds another isolate already changed.
 */

const KEY = "csm:wins-config:v1";

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

interface StoredBlob {
  overrides: DeepPartial<WinsConfig>;
  updated_at: string;
  updated_by?: string | null;
}

/** Read the raw override blob. Callers that want the effective (merged
 *  onto defaults) config should use `loadWinsConfig()` instead. Used
 *  by the settings page to render "current vs. default" side by side. */
export async function loadWinsConfigOverrides(): Promise<DeepPartial<WinsConfig>> {
  const blob = await kvGet<StoredBlob>(KEY);
  return blob?.overrides ?? {};
}

/** Effective config the engine runs against — merged over defaults. */
export async function loadWinsConfig(): Promise<WinsConfig> {
  const overrides = await loadWinsConfigOverrides();
  return mergeWinsConfig(overrides);
}

/** Write a new override blob. The settings page always PUTs the
 *  whole overrides object — clearing a field to "default" is done
 *  by omitting it, not by writing the default value verbatim, so a
 *  future default change propagates. */
export async function saveWinsConfigOverrides(
  overrides: DeepPartial<WinsConfig>,
  updatedBy: string | null = null
): Promise<void> {
  const blob: StoredBlob = {
    overrides,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  await kvSet(KEY, blob);
}

export async function loadWinsConfigMeta(): Promise<{
  updated_at: string | null;
  updated_by: string | null;
}> {
  const blob = await kvGet<StoredBlob>(KEY);
  if (!blob) return { updated_at: null, updated_by: null };
  return {
    updated_at: blob.updated_at,
    updated_by: blob.updated_by ?? null,
  };
}

/** Re-export defaults for callers that render the "default" column
 *  in the settings UI. */
export { DEFAULT_WINS_CONFIG };
