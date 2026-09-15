import { loadAdminFlags } from "../data/admin-flags";
import {
  applyGate,
  DEFAULT_FLAGS,
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

/** True when the flag's admin gate has `restricted: false` — i.e.
 *  the feature has been opened up to everyone who passes its own
 *  eligibility check. Used by the settings layout to promote
 *  formerly-gated features out of the "Feature settings" hub and
 *  into the primary sidebar list once they graduate to general
 *  availability.
 *
 *  Falls through to DEFAULT_FLAGS when the KV row is absent so a
 *  fresh install has the same promotion behavior a saved-and-
 *  cleared row does. Soft-fails to `false` on KV errors — same
 *  posture as `isFeatureEnabledFor`: under-promote before over-
 *  promote. */
export async function isFeatureUnrestricted(
  featureId: FeatureId
): Promise<boolean> {
  try {
    const flags = await loadCachedFlags();
    const gate =
      flags.features?.[featureId] ?? DEFAULT_FLAGS.features[featureId];
    return !gate?.restricted;
  } catch {
    return false;
  }
}
