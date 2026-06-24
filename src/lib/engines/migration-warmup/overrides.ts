/**
 * Admin-tunable knobs for the migration warm-up algorithm.
 *
 * Defaults live in `config.json` (the source of truth + what the
 * Python reference uses). Anything saved here is treated as an
 * override layer the API route merges on top before invoking the
 * engine. That lets the CSM team tune the most-tweakable values
 * (open-rate threshold for conservative, approach multipliers,
 * the 52-week safety bound) without a code edit + redeploy.
 *
 * Why this small set:
 *   • Open-rate threshold drives whether a list lands in
 *     `conservative` mode. Surfacing it is the request that
 *     prompted this file.
 *   • Multipliers are the obvious second-order tuning — once we
 *     decide "this is conservative", how much slower is it?
 *   • max_weeks is the safety bound for "schedule too slow" errors.
 *
 * Tier boundaries (Micro / Small / Medium / Large / Super Large)
 * are deliberately NOT exposed — those are deep algorithm shape,
 * not a settings-level knob. Same with rounding bands.
 *
 * Pure types — safe to import from client components.
 */

import type { Approach } from "./types";

export interface MigrationOverrides {
  /** Open rate (0..1) below which the algorithm forces conservative
   *  pacing. Reference default: 0.30. */
  open_rate_conservative_threshold?: number;
  /** Multipliers applied to per-batch sizes before cap enforcement.
   *  Reference defaults: standard 1.0, conservative 0.75, aggressive 1.25. */
  approach_multipliers?: Partial<Record<Approach, number>>;
  /** Safety bound: engine throws if a schedule would exceed this
   *  many weeks. Reference default: 52. */
  max_weeks?: number;
}

/** Hard-coded matches the bundled config.json — kept here so the
 *  settings UI can show defaults inline without importing the JSON. */
export const DEFAULTS = {
  open_rate_conservative_threshold: 0.3,
  approach_multipliers: {
    standard: 1.0,
    conservative: 0.75,
    aggressive: 1.25,
  } satisfies Record<Approach, number>,
  max_weeks: 52,
};
