import { loadAdminFlags } from "../data/admin-flags";
import {
  applyGate,
  type FeatureId,
} from "../data/admin-flags-types";

/**
 * Server-side check for "should this user get this feature?" Reads
 * the admin-flags KV row + applies the gate semantics from
 * applyGate(). 60-second cache because the row is small + a stale
 * read is fine for at most a minute after the admin flips a switch.
 *
 * Pair with the feature's own eligibility check (e.g. `isCsmWithGmail`
 * for personalization) at the same gate point so a flag flip can
 * narrow access but never grant it outside the eligibility envelope.
 */

const CACHE_TTL_MS = 60 * 1000;
let cache: { expires: number; flagsPromise: ReturnType<typeof loadAdminFlags> } | null = null;

async function loadCachedFlags() {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.flagsPromise;
  const flagsPromise = loadAdminFlags();
  cache = { expires: now + CACHE_TTL_MS, flagsPromise };
  return flagsPromise;
}

export async function isFeatureEnabledFor(
  featureId: FeatureId,
  email: string | null | undefined
): Promise<boolean> {
  if (!email) return false;
  try {
    const flags = await loadCachedFlags();
    return applyGate(flags, featureId, email);
  } catch {
    // Soft-fail to false. A KV read blip shouldn't let a feature
    // bleed through when the admin has gated it; better to under-
    // grant than over-grant.
    return false;
  }
}

/** Bust the in-memory cache. Called from the /api/admin/flags PUT
 *  so a save propagates without waiting out the 60s TTL. */
export function invalidateFeatureFlagsCache() {
  cache = null;
}
