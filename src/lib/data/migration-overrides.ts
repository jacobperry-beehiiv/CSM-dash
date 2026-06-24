import { kvGet, kvSet } from "../storage/kv";
import {
  DEFAULTS,
  type MigrationOverrides,
} from "../engines/migration-warmup/overrides";
import type { Approach } from "../engines/migration-warmup/types";

/**
 * KV-backed admin overrides for the migration warm-up engine.
 *
 * Server-only loader + saver. The settings UI talks to
 * /api/admin/migration-overrides which calls these; the migration
 * API route calls loadMigrationOverrides() before invoking the
 * engine.
 */

const KEY = "csm:migration-warmup:overrides:v1";

export async function loadMigrationOverrides(): Promise<MigrationOverrides> {
  return (await kvGet<MigrationOverrides>(KEY)) ?? {};
}

/** Sanitize then store. Out-of-range or non-numeric values are
 *  dropped silently (they fall back to defaults at the engine
 *  layer), so a bad PUT can't put the engine in a broken state. */
export async function saveMigrationOverrides(
  next: MigrationOverrides
): Promise<MigrationOverrides> {
  const clean: MigrationOverrides = {};
  if (
    typeof next.open_rate_conservative_threshold === "number" &&
    next.open_rate_conservative_threshold >= 0 &&
    next.open_rate_conservative_threshold <= 1
  ) {
    clean.open_rate_conservative_threshold =
      next.open_rate_conservative_threshold;
  }
  if (next.approach_multipliers) {
    const m: Partial<Record<Approach, number>> = {};
    for (const k of ["standard", "conservative", "aggressive"] as const) {
      const v = next.approach_multipliers[k];
      // Multipliers must be strictly positive; 0 would zero out
      // every batch and the engine would loop until max_weeks.
      if (typeof v === "number" && v > 0 && v <= 10) m[k] = v;
    }
    if (Object.keys(m).length > 0) clean.approach_multipliers = m;
  }
  if (
    typeof next.max_weeks === "number" &&
    Number.isInteger(next.max_weeks) &&
    next.max_weeks >= 4 &&
    next.max_weeks <= 200
  ) {
    clean.max_weeks = next.max_weeks;
  }
  await kvSet(KEY, clean);
  return clean;
}

/** Merge overrides on top of the reference defaults. Returns a
 *  fully-populated config object the engine can rely on. Pure —
 *  no I/O. */
export function effectiveOverrides(overrides: MigrationOverrides): {
  open_rate_conservative_threshold: number;
  approach_multipliers: Record<Approach, number>;
  max_weeks: number;
} {
  return {
    open_rate_conservative_threshold:
      overrides.open_rate_conservative_threshold ??
      DEFAULTS.open_rate_conservative_threshold,
    approach_multipliers: {
      standard:
        overrides.approach_multipliers?.standard ??
        DEFAULTS.approach_multipliers.standard,
      conservative:
        overrides.approach_multipliers?.conservative ??
        DEFAULTS.approach_multipliers.conservative,
      aggressive:
        overrides.approach_multipliers?.aggressive ??
        DEFAULTS.approach_multipliers.aggressive,
    },
    max_weeks: overrides.max_weeks ?? DEFAULTS.max_weeks,
  };
}
