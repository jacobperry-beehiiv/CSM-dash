import configJson from "./config.json";
import { DEFAULTS, type MigrationOverrides } from "./overrides";
import type {
  Approach,
  Batch,
  ListInput,
  ListSchedule,
  MigrationPlan,
  PlanInput,
  Week,
} from "./types";

/** Resolve admin overrides → fully-populated knob values. Pure, sync.
 *  Used by `determineApproach`, `_buildWeeks`, `generateSchedule`. */
function resolveKnobs(overrides?: MigrationOverrides) {
  return {
    openRateThreshold:
      overrides?.open_rate_conservative_threshold ??
      DEFAULTS.open_rate_conservative_threshold,
    approachMultipliers: {
      standard:
        overrides?.approach_multipliers?.standard ??
        DEFAULTS.approach_multipliers.standard,
      conservative:
        overrides?.approach_multipliers?.conservative ??
        DEFAULTS.approach_multipliers.conservative,
      aggressive:
        overrides?.approach_multipliers?.aggressive ??
        DEFAULTS.approach_multipliers.aggressive,
    } satisfies Record<Approach, number>,
    maxWeeks: overrides?.max_weeks ?? DEFAULTS.max_weeks,
  };
}

/**
 * Deterministic beehiiv migration warm-up scheduler.
 *
 * 1:1 TypeScript port of the Python reference at
 * `~/Library/.../migration_warmup.py`. All tier tables, caps,
 * multipliers + rounding bands live in config.json — change the
 * config to change behavior; the engine itself never embeds numbers.
 *
 * Same `generate_schedule(li)` → `ListSchedule` contract as the
 * Python impl. The test file pulls the worked examples from the
 * Python tests verbatim — cross-language fixtures.
 */

interface TierConfig {
  name: string;
  min: number;
  max: number | null;
  max_batches_default?: number | null;
  week1_max_batches?: number;
  // Micro:
  profile_selector?: string;
  profiles?: Record<string, MicroProfile>;
  // Other tiers:
  week1?: Week1Spec;
  progression?: number[];
  continuation_batch?: number;
  caps?: number[];
  cap_continuation_increment: number;
}

interface MicroProfile {
  applies_when_spw_gte: number;
  progression: number[];
  continuation_batch: number;
  caps: number[];
}

interface Week1Spec {
  default_batch?: number;
  max_batches?: number;
  overrides?: Record<string, number[]>;
  explicit_bands?: Array<{ min_spw: number; batches: number[] }>;
}

interface Config {
  cadence_map: Record<string, number>;
  cadence_flags: Record<string, string>;
  tiers: TierConfig[];
  approach_multipliers: Record<Approach, number>;
  rounding_ladder: { bands: Array<{ below: number | null; round_to: number }> };
  limits: { max_weeks: number };
}

const CONFIG = configJson as unknown as Config;

// --------------------------------------------------------------------- //
// Normalization
// --------------------------------------------------------------------- //

export function normalizeCadence(text: string): {
  spw: number;
  flag: string | null;
} {
  const raw = (text ?? "").trim().toLowerCase();
  const map = CONFIG.cadence_map;
  const flags = CONFIG.cadence_flags;
  // Longest-key match wins so "1x/week" beats "1x".
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (raw.includes(key)) {
      return { spw: map[key], flag: flags[key] ?? null };
    }
  }
  return {
    spw: 1,
    flag: `Unrecognized cadence '${text}' treated as 1x/week — confirm.`,
  };
}

export function normalizeSubscribers(value: number | string): number {
  if (typeof value === "number") return Math.round(value);
  const s = String(value).trim().toLowerCase().replace(/,/g, "").replace(/~/g, "");
  // Range → midpoint. e.g. "15-25k".
  const range = s.match(/(\d+\.?\d*)\s*k?\s*[-–]\s*(\d+\.?\d*)\s*k?/);
  if (range) {
    const lo = _kify(range[1], s);
    const hi = _kify(range[2], s);
    return Math.round((lo + hi) / 2);
  }
  const nums = s.match(/(\d+\.?\d*)/);
  if (!nums) throw new Error(`Cannot parse subscriber count: ${value}`);
  return Math.round(_kify(nums[1], s));
}

function _kify(numStr: string, ctx: string): number {
  let n = parseFloat(numStr);
  if (ctx.includes("k") && n < 10000) n *= 1000;
  return n;
}

export function normalizeOpenRate(
  value: number | string | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return value > 1 ? value / 100 : value;
  }
  const s = String(value).trim().toLowerCase();
  if (s === "" || s === "unknown" || s === "n/a" || s === "na" || s === "none") {
    return null;
  }
  const m = s.match(/(\d+\.?\d*)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return v > 1 ? v / 100 : v;
}

// --------------------------------------------------------------------- //
// Tier + approach + rounding
// --------------------------------------------------------------------- //

export function tierFor(subscribers: number): TierConfig {
  for (const tier of CONFIG.tiers) {
    const hi = tier.max;
    if (subscribers >= tier.min && (hi === null || subscribers <= hi)) {
      return tier;
    }
  }
  throw new Error(`No tier matches ${subscribers}`);
}

export function roundClean(x: number): number {
  if (x <= 0) return 0;
  for (const band of CONFIG.rounding_ladder.bands) {
    const below = band.below;
    if (below === null || x < below) {
      return Math.round(x / band.round_to) * band.round_to;
    }
  }
  return Math.round(x);
}

export function determineApproach(
  li: ListInput,
  spw: number,
  overrides?: MigrationOverrides
): Approach {
  const knobs = resolveKnobs(overrides);
  const openRate = normalizeOpenRate(li.open_rate);
  const conservative =
    openRate === null ||
    openRate < knobs.openRateThreshold ||
    li.deliverability_concern === true;
  if (conservative) return "conservative";
  if (li.deadline_weeks !== null && li.deadline_weeks !== undefined) {
    const subs = normalizeSubscribers(li.subscribers);
    const stdWeeks = _buildWeeks(tierFor(subs), "standard", spw, subs, overrides).length;
    if (li.deadline_weeks < stdWeeks) return "aggressive";
  }
  return "standard";
}

// --------------------------------------------------------------------- //
// Core scheduling engine
// --------------------------------------------------------------------- //

function _selectMicroProfile(tier: TierConfig, spw: number): MicroProfile {
  const profiles = tier.profiles!;
  if (spw >= profiles.multi.applies_when_spw_gte) return profiles.multi;
  return profiles.single;
}

function _week1Batches(
  tier: TierConfig,
  spw: number,
  multiplier: number
): number[] {
  const spwInt = spw >= 1 ? Math.max(1, Math.floor(spw)) : 1;
  if (tier.profiles) {
    // Micro
    const prof = _selectMicroProfile(tier, spw);
    const base = prof.progression[0];
    const n = Math.min(spwInt, tier.week1_max_batches ?? 2);
    return Array.from({ length: n }, () => roundClean(base * multiplier));
  }
  const w1 = tier.week1!;
  if (w1.explicit_bands) {
    // Medium-style: mixed batch sizes per cadence band.
    for (const band of w1.explicit_bands) {
      if (spw >= band.min_spw) {
        return band.batches.map((b) => roundClean(b * multiplier));
      }
    }
    const last = w1.explicit_bands[w1.explicit_bands.length - 1];
    return last.batches.map((b) => roundClean(b * multiplier));
  }
  // Uniform week-1 batch with optional per-cadence override.
  const overrides = w1.overrides ?? {};
  if (overrides[String(spwInt)]) {
    return overrides[String(spwInt)].map((b) => roundClean(b * multiplier));
  }
  const n = Math.min(spwInt, w1.max_batches ?? spwInt);
  return Array.from({ length: n }, () =>
    roundClean((w1.default_batch ?? 0) * multiplier)
  );
}

function _batchSizeForWeek(
  tier: TierConfig,
  spw: number,
  weekIdx: number,
  multiplier: number
): number {
  let prog: number[];
  let cont: number;
  let pos: number;
  if (tier.profiles) {
    const prof = _selectMicroProfile(tier, spw);
    prog = prof.progression;
    cont = prof.continuation_batch;
    // Micro week 1 already consumed progression[0]; week N → prog[N-1]
    pos = weekIdx - 1;
  } else {
    prog = tier.progression!;
    cont = tier.continuation_batch!;
    // Other tiers: week 1 has its own spec; week 2 → prog[0]
    pos = weekIdx - 2;
  }
  const base = pos < prog.length ? prog[pos] : cont;
  return roundClean(base * multiplier);
}

function _capForWeek(
  tier: TierConfig,
  spw: number,
  weekIdx: number
): number | null {
  let caps: number[];
  if (tier.profiles) {
    caps = _selectMicroProfile(tier, spw).caps;
  } else {
    caps = tier.caps!;
  }
  const inc = tier.cap_continuation_increment;
  if (weekIdx <= caps.length) return caps[weekIdx - 1];
  const extra = weekIdx - caps.length;
  return caps[caps.length - 1] + inc * extra;
}

function _maxBatches(tier: TierConfig, spw: number): number {
  const def = tier.max_batches_default ?? null;
  const spwInt = spw >= 1 ? Math.max(1, Math.floor(spw)) : 1;
  if (def === null) return spwInt;
  return Math.min(def, spwInt);
}

function _weekLabel(weekIdx: number, biWeekly: boolean): string {
  if (biWeekly) {
    const start = weekIdx * 2 - 1;
    return `Weeks ${start}-${start + 1}`;
  }
  return `Week ${weekIdx}`;
}

function _buildWeeks(
  tier: TierConfig,
  approach: Approach,
  spw: number,
  listSize: number,
  overrides?: MigrationOverrides
): Week[] {
  const knobs = resolveKnobs(overrides);
  const multiplier = knobs.approachMultipliers[approach];
  const maxWeeks = knobs.maxWeeks;
  const biWeekly = spw === 0.5;

  const weeks: Week[] = [];
  let cumulative = 0;
  let weekIdx = 0;

  while (cumulative < listSize) {
    weekIdx += 1;
    if (weekIdx > maxWeeks) {
      throw new Error(
        `Schedule exceeded ${maxWeeks} weeks for list_size=${listSize}, ` +
          `cadence spw=${spw}. Cadence likely too slow for this list.`
      );
    }

    let batchSizes: number[];
    if (weekIdx === 1) {
      batchSizes = _week1Batches(tier, spw, multiplier);
    } else {
      const n = biWeekly ? 1 : _maxBatches(tier, spw);
      const size = _batchSizeForWeek(tier, spw, weekIdx, multiplier);
      batchSizes = Array.from({ length: n }, () => size);
    }
    const cap = _capForWeek(tier, spw, weekIdx);

    const batches: Batch[] = [];
    for (const size of batchSizes) {
      const remaining = listSize - cumulative;
      if (remaining <= 0) break;
      let s = Math.min(size, remaining); // final-batch trueing
      if (cap !== null && cumulative + s > cap) {
        s = cap - cumulative; // cap enforcement
      }
      if (s <= 0) break; // cap reached; carry to next week
      cumulative += s;
      batches.push({
        index: batches.length + 1,
        size: s,
        cumulative,
      });
    }

    // If cap blocked every batch this week but list isn't done, still
    // record an empty week so the loop visibly advances + the cap
    // gets a chance to grow next iteration.
    if (batches.length === 0 && cumulative < listSize) {
      weeks.push({
        number: weekIdx,
        label: _weekLabel(weekIdx, biWeekly),
        week_total: 0,
        cumulative,
        batches: [],
      });
      continue;
    }

    const weekTotal = batches.reduce((s, b) => s + b.size, 0);
    weeks.push({
      number: weekIdx,
      label: _weekLabel(weekIdx, biWeekly),
      week_total: weekTotal,
      cumulative,
      batches,
    });
  }

  return weeks;
}

// --------------------------------------------------------------------- //
// Top-level generators
// --------------------------------------------------------------------- //

export function generateSchedule(
  li: ListInput,
  overrides?: MigrationOverrides
): ListSchedule {
  const knobs = resolveKnobs(overrides);
  const subs = normalizeSubscribers(li.subscribers);
  const { spw, flag: cadenceFlag } = normalizeCadence(li.cadence);
  const openRate = normalizeOpenRate(li.open_rate);
  const tier = tierFor(subs);
  const approach = determineApproach(li, spw, overrides);
  const weeks = _buildWeeks(tier, approach, spw, subs, overrides);

  const flags: string[] = [];
  if (cadenceFlag) flags.push(cadenceFlag);
  if (openRate === null) {
    flags.push(
      "Open rate unknown — used conservative approach; confirm OR before sharing with customer."
    );
  } else if (openRate < knobs.openRateThreshold) {
    flags.push(
      `Open rate ${Math.round(openRate * 100)}% < ${Math.round(knobs.openRateThreshold * 100)}% — conservative approach.`
    );
  }
  if (li.deliverability_concern) {
    flags.push("Deliverability concern flagged — conservative approach.");
  }
  if (approach === "aggressive") {
    flags.push(
      `Deadline (${li.deadline_weeks}w) tighter than standard timeline — aggressive approach.`
    );
  }

  // Invariants: cumulative must end at exactly list_size and no
  // week's cumulative may exceed its cap (final completing week
  // exempted).
  const last = weeks[weeks.length - 1];
  if (last.cumulative !== subs) {
    throw new Error(
      `Schedule invariant failed: final cumulative ${last.cumulative} !== list size ${subs}`
    );
  }
  for (const w of weeks) {
    const cap = _capForWeek(tier, spw, w.number);
    if (cap !== null && w.cumulative > cap && w.cumulative !== subs) {
      throw new Error(
        `Schedule invariant failed: week ${w.number} cumulative ${w.cumulative} exceeds cap ${cap}`
      );
    }
  }

  const etaWeeks = spw === 0.5 ? weeks.length * 2 : weeks.length;
  return {
    name: li.name.trim(),
    subscribers: subs,
    cadence: li.cadence.trim(),
    sends_per_week: spw,
    open_rate: openRate,
    tier: tier.name,
    approach,
    total_weeks: weeks.length,
    eta: `${etaWeeks} weeks`,
    flags,
    weeks,
  };
}

export function buildPlan(
  plan: PlanInput,
  overrides?: MigrationOverrides
): MigrationPlan {
  const schedules = plan.lists.map((li) => generateSchedule(li, overrides));
  return {
    customer_name: plan.customer_name.trim(),
    structure: plan.structure ?? "separate",
    drive_folder_url: plan.drive_folder_url ?? null,
    schedules,
  };
}
