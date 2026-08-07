import { kvGet, kvSet } from "../storage/kv";
import {
  DEFAULT_UPGRADE_ANALYSIS_CONFIG,
  mergeUpgradeAnalysisConfig,
  type UpgradeAnalysisConfig,
  type UpgradeAnalysisConfigOverrides,
} from "./upgrade-analysis-config-types";

/**
 * Server-only KV store for admin overrides of the D&C Upgrade Analysis
 * threshold registry. The engine calls `loadUpgradeAnalysisConfig()`
 * once per scan, then hands the merged blob down to rules.ts.
 *
 * Same posture as wins-config: no module-level cache — a warm isolate
 * could otherwise score against thresholds another isolate already
 * changed.
 */

const KEY = "csm:upgrade-analysis-config:v1";

interface StoredBlob {
  overrides: UpgradeAnalysisConfigOverrides;
  updated_at: string;
  updated_by?: string | null;
}

export async function loadUpgradeAnalysisConfigOverrides(): Promise<UpgradeAnalysisConfigOverrides> {
  const blob = await kvGet<StoredBlob>(KEY);
  return blob?.overrides ?? {};
}

/** Effective config the engine runs against — merged over defaults. */
export async function loadUpgradeAnalysisConfig(): Promise<UpgradeAnalysisConfig> {
  const overrides = await loadUpgradeAnalysisConfigOverrides();
  return mergeUpgradeAnalysisConfig(overrides);
}

export async function saveUpgradeAnalysisConfigOverrides(
  overrides: UpgradeAnalysisConfigOverrides,
  updatedBy: string | null = null
): Promise<void> {
  const blob: StoredBlob = {
    overrides,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  await kvSet(KEY, blob);
}

export async function loadUpgradeAnalysisConfigMeta(): Promise<{
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

export { DEFAULT_UPGRADE_ANALYSIS_CONFIG };
