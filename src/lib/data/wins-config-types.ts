/**
 * Client-safe types + defaults for the Wins & Opportunities rule
 * catalog thresholds. Same split pattern as admin-flags-types /
 * settings-types — the server-only KV store lives in wins-config.ts.
 *
 * These defaults were shipped in Phase 1 and iterated on Jacob's
 * book. Admins can override any subset via /settings/wins; the
 * engine reads DEFAULTS ← overrides at run time.
 */

export interface VerifiedCtorRecordConfig {
  min_delivered_on_record: number;
  lookback_days: number;
  min_beat_pp: number;
}

export interface VerifiedOpenStreakConfig {
  min_streak_weeks: number;
  baseline_weeks: number;
  min_lift_pp: number;
  min_sends_per_week: number;
}

export interface QualityGrowthConfig {
  min_weeks: number;
  min_open_rate_retention: number;
  min_engaged_end: number;
}

export interface DeliverabilityStreakConfig {
  min_streak_weeks: number;
  min_delivery_rate: number;
  max_hard_bounce_rate: number;
  min_sends_per_week: number;
  /** Guardrail: no point celebrating "clean deliverability" if nobody
   *  opens. Added in Phase 1 v2 after the sanity check on Jacob's
   *  book showed 89% of publications matched the pre-open-rate
   *  version — turning the win into background noise. */
  min_open_rate: number;
}

export interface WinsConfig {
  verified_ctor_record: VerifiedCtorRecordConfig;
  verified_open_streak: VerifiedOpenStreakConfig;
  quality_growth: QualityGrowthConfig;
  deliverability_streak: DeliverabilityStreakConfig;
}

/** Shipped defaults. Tightened post-Phase-1 sanity check on Jacob's
 *  book. Rule 4 (deliverability_streak) was the biggest change:
 *  4→8 week streak, 0.97→0.99 delivery floor, 250→1000 sends/week,
 *  and a new 25% open-rate guardrail — see the sanity-check chat
 *  thread for the 89%→~15 hit-rate math. */
export const DEFAULT_WINS_CONFIG: WinsConfig = {
  verified_ctor_record: {
    min_delivered_on_record: 500,
    lookback_days: 90,
    min_beat_pp: 0.005,
  },
  verified_open_streak: {
    min_streak_weeks: 3,
    baseline_weeks: 12,
    min_lift_pp: 0.02,
    min_sends_per_week: 250,
  },
  quality_growth: {
    min_weeks: 4,
    min_open_rate_retention: 0.9,
    min_engaged_end: 400,
  },
  deliverability_streak: {
    min_streak_weeks: 8,
    min_delivery_rate: 0.99,
    max_hard_bounce_rate: 0.002,
    min_sends_per_week: 1000,
    min_open_rate: 0.25,
  },
};

/** Deep-merge a Partial<WinsConfig> onto DEFAULT_WINS_CONFIG. Any
 *  missing rule or field falls through to the default so overrides
 *  can be sparse (e.g. bump just one threshold). */
export function mergeWinsConfig(
  overrides: DeepPartial<WinsConfig> | null | undefined
): WinsConfig {
  if (!overrides) return DEFAULT_WINS_CONFIG;
  return {
    verified_ctor_record: {
      ...DEFAULT_WINS_CONFIG.verified_ctor_record,
      ...(overrides.verified_ctor_record ?? {}),
    },
    verified_open_streak: {
      ...DEFAULT_WINS_CONFIG.verified_open_streak,
      ...(overrides.verified_open_streak ?? {}),
    },
    quality_growth: {
      ...DEFAULT_WINS_CONFIG.quality_growth,
      ...(overrides.quality_growth ?? {}),
    },
    deliverability_streak: {
      ...DEFAULT_WINS_CONFIG.deliverability_streak,
      ...(overrides.deliverability_streak ?? {}),
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

/** Human-friendly metadata for the /settings/wins UI. Every numeric
 *  field the settings form renders needs an entry here so we can
 *  show units + a one-line hint. Kept in-repo (not KV) — updating
 *  the copy is a code change. */
export interface FieldMeta {
  key: string;
  label: string;
  hint: string;
  unit: "count" | "days" | "pct_absolute" | "weeks" | "ratio";
  step: number;
  min?: number;
  max?: number;
}

export interface RuleMeta {
  key: keyof WinsConfig;
  label: string;
  description: string;
  fields: FieldMeta[];
}

export const WINS_CONFIG_META: RuleMeta[] = [
  {
    key: "verified_ctor_record",
    label: "Best-ever CTOR record",
    description:
      "Latest post beats every prior post in the lookback window by ≥ min-beat-pp on click-to-open rate.",
    fields: [
      {
        key: "min_delivered_on_record",
        label: "Min delivered on record post",
        hint: "Blocks small-list vanity spikes.",
        unit: "count",
        step: 100,
        min: 0,
      },
      {
        key: "lookback_days",
        label: "Lookback days",
        hint: "How far back to compare against.",
        unit: "days",
        step: 1,
        min: 7,
        max: 365,
      },
      {
        key: "min_beat_pp",
        label: "Min beat over prior best (pp)",
        hint: "0.005 = 0.5 percentage points. Filters ties + noise.",
        unit: "pct_absolute",
        step: 0.001,
        min: 0,
        max: 0.2,
      },
    ],
  },
  {
    key: "verified_open_streak",
    label: "Open-rate streak vs baseline",
    description:
      "Recent weeks all above the trailing baseline by ≥ min-lift-pp.",
    fields: [
      {
        key: "min_streak_weeks",
        label: "Streak weeks required",
        hint: "Consecutive weeks that must beat the baseline.",
        unit: "weeks",
        step: 1,
        min: 1,
        max: 26,
      },
      {
        key: "baseline_weeks",
        label: "Baseline window (weeks)",
        hint: "How many prior weeks compute the trailing baseline.",
        unit: "weeks",
        step: 1,
        min: 4,
        max: 52,
      },
      {
        key: "min_lift_pp",
        label: "Min lift vs baseline (pp)",
        hint: "Each streak week's open rate must exceed baseline by this much.",
        unit: "pct_absolute",
        step: 0.005,
        min: 0,
        max: 0.5,
      },
      {
        key: "min_sends_per_week",
        label: "Min sends per streak week",
        hint: "Skip weeks with less than this send volume — reduces low-N noise.",
        unit: "count",
        step: 50,
        min: 0,
      },
    ],
  },
  {
    key: "quality_growth",
    label: "Engaged audience growth",
    description:
      "Engaged audience (delivered × open rate) grows for consecutive weeks without the open rate collapsing.",
    fields: [
      {
        key: "min_weeks",
        label: "Consecutive growth weeks",
        hint: "How many weeks in a row engaged audience must climb.",
        unit: "weeks",
        step: 1,
        min: 2,
        max: 26,
      },
      {
        key: "min_open_rate_retention",
        label: "Min open-rate retention",
        hint: "0.9 = open rate can't drop below 90% of week-1's value.",
        unit: "ratio",
        step: 0.05,
        min: 0.5,
        max: 1,
      },
      {
        key: "min_engaged_end",
        label: "Min engaged audience at end",
        hint: "Filters growth from '100 to 150' — meaningful floor.",
        unit: "count",
        step: 100,
        min: 0,
      },
    ],
  },
  {
    key: "deliverability_streak",
    label: "Deliverability streak",
    description:
      "Consecutive weeks of clean inbox placement + engagement floor.",
    fields: [
      {
        key: "min_streak_weeks",
        label: "Streak weeks required",
        hint: "Consecutive weeks meeting every gate below.",
        unit: "weeks",
        step: 1,
        min: 2,
        max: 26,
      },
      {
        key: "min_delivery_rate",
        label: "Min delivery rate",
        hint: "0.99 = 99% delivered. Set at 'genuinely clean' rather than 'not broken.'",
        unit: "ratio",
        step: 0.005,
        min: 0.9,
        max: 1,
      },
      {
        key: "max_hard_bounce_rate",
        label: "Max hard bounce rate",
        hint: "Hard bounces stay below this each streak week.",
        unit: "ratio",
        step: 0.001,
        min: 0,
        max: 0.05,
      },
      {
        key: "min_sends_per_week",
        label: "Min sends per streak week",
        hint: "Skip small-N weeks that trivially hit the ratio floors.",
        unit: "count",
        step: 100,
        min: 0,
      },
      {
        key: "min_open_rate",
        label: "Min open rate",
        hint: "Guard so we don't celebrate 'clean' on a publication nobody opens.",
        unit: "ratio",
        step: 0.05,
        min: 0,
        max: 1,
      },
    ],
  },
];
