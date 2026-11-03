/**
 * Engagement-trend types — client-safe
 * ------------------------------------
 * Split from `engagement-trends.ts` because the customer table is a
 * client component and needs these shapes to colour a row, while the
 * engine itself imports Metabase + kv (server-only). Same split the
 * codebase uses elsewhere for `*-types.ts`.
 *
 * WHAT THIS MODELS, AND WHY IT ISN'T THE DELIVERABILITY ALERT
 * -----------------------------------------------------------
 * `lib/thresholds.ts` answers "is THIS SEND bad right now?" — absolute
 * bands on a single post. It cannot answer "is this publication
 * getting worse?", and that blind spot is wide: a newsletter sliding
 * 99.5% -> 96.4% delivery over eight weeks never trips the 95%
 * critical band, and one losing 51% -> 39% open rate never trips
 * anything at all, because the warning band is 20%.
 *
 * Those are real examples from the book, not hypotheticals. This
 * module exists to catch exactly that class of decline — degradation
 * that is still comfortably inside the healthy range.
 *
 * Deliberately the COMPLEMENT of the threshold alert: a publication
 * whose current numbers already trip `analyzePost` is excluded here,
 * because the existing alert owns it and showing it twice would just
 * split the CSM's attention between two surfaces.
 */

// ─── Metrics ──────────────────────────────────────────────────────

/**
 * The six rates derivable from `fact_sendables_by_type_v1` alone.
 *
 * Unsub rate is conspicuously absent: unsubs live in
 * `state_events_unsubscribe_post_id` and need a separate per-post
 * query (the deliverability engine's Q3). Pulling it would roughly
 * double the sweep's query count for one more metric, so it's out of
 * v1 — add it only if the trend report proves it's worth the cost.
 */
export type TrendMetric =
  | "delivery_rate"
  | "open_rate"
  | "click_rate"
  | "hard_bounce_rate"
  | "soft_bounce_rate"
  | "spam_rate";

export const TREND_METRICS: readonly TrendMetric[] = [
  "delivery_rate",
  "open_rate",
  "click_rate",
  "hard_bounce_rate",
  "soft_bounce_rate",
  "spam_rate",
] as const;

export const TREND_METRIC_LABELS: Record<TrendMetric, string> = {
  delivery_rate: "Delivery rate",
  open_rate: "Open rate",
  click_rate: "Click rate",
  hard_bounce_rate: "Hard bounce rate",
  soft_bounce_rate: "Soft bounce rate",
  spam_rate: "Spam rate",
};

/** Which way is bad. Drives sign handling everywhere downstream, so
 *  it lives with the metric list rather than being re-derived. */
export const TREND_METRIC_DIRECTION: Record<
  TrendMetric,
  "lower_is_worse" | "higher_is_worse"
> = {
  delivery_rate: "lower_is_worse",
  open_rate: "lower_is_worse",
  click_rate: "lower_is_worse",
  hard_bounce_rate: "higher_is_worse",
  soft_bounce_rate: "higher_is_worse",
  spam_rate: "higher_is_worse",
};

// ─── Per-metric trend ─────────────────────────────────────────────

export interface MetricTrend {
  metric: TrendMetric;
  /** Rate over the recent window (volume-weighted across sends). */
  recent: number;
  /** Rate over the baseline window. */
  baseline: number;
  /** recent - baseline, signed and raw. Negative means the rate fell,
   *  which is bad for delivery/open/click and GOOD for bounce/spam —
   *  read it together with TREND_METRIC_DIRECTION. */
  delta: number;
  /**
   * `delta` minus the whole Enterprise cohort's move over the same two
   * windows.
   *
   * This is the single thing that keeps the report credible. Open
   * rates sag across every newsletter over a holiday period; without
   * subtracting that, the report lights up the entire book every
   * December and gets ignored by January. What we actually want is
   * "worse than the market", and the cohort move is free to compute
   * because the sweep already visits every publication.
   */
  cohort_adjusted_delta: number;
  /** The cohort's own move, kept so the UI can say "everyone fell
   *  1.2pt" rather than silently adjusting the number. */
  cohort_delta: number;
  /**
   * `delta` divided by the publication's own historical week-to-week
   * variation (1.4826 x median absolute deviation of the baseline
   * weeks, the standard normal-consistent MAD scaling).
   *
   * Why normalise at all: a 2-point open-rate drop is meaningless for
   * a publication that routinely swings +/-8 points and alarming for
   * one that holds +/-0.5. An absolute threshold on `delta` would
   * drown the second case in false positives from the first.
   *
   * Not a binomial standard error on purpose. With n in the hundreds
   * of thousands, SE is vanishingly small and EVERY change reads as
   * significant — the classic big-n trap. Real send-to-send variation
   * is far larger than binomial, so it has to be measured empirically.
   */
  robust_z: number;
  /** OLS slope over the weekly series, expressed in rate-points per
   *  30 days. Signed like `delta`. */
  slope_per_30d: number;
  /** The critical band from `lib/thresholds.ts`, when the metric has
   *  one. */
  threshold: number | null;
  /**
   * Weeks until the current slope carries this metric across its
   * critical threshold. null when it isn't heading there (flat,
   * improving, or no threshold).
   *
   * This is the ranking key, not severity-in-the-abstract. "Delivery
   * falling 0.9pt/month, crosses 95% in ~6 weeks" is a queue a CSM can
   * work through; a z-score is not.
   */
  weeks_to_threshold: number | null;
  /** 0-100. See scoreMetric() in the engine for the weighting. */
  severity: number;
}

// ─── Publication + workspace rollups ──────────────────────────────

export interface PublicationTrend {
  publication_id: string;
  publication_name: string | null;
  workspace_id: string;
  workspace_name: string | null;
  sends_recent: number;
  sends_baseline: number;
  recipients_recent: number;
  recipients_baseline: number;
  /**
   * Recent recipients-per-day over baseline recipients-per-day.
   *
   * Earns its place by killing the report's worst false positive.
   * One publication in testing showed a 21-point open-rate collapse
   * that looked like a deliverability emergency — until this ratio
   * showed sends had gone 336k -> 31k. They had switched to mailing
   * only an engaged segment; the rate move was arithmetic, not a
   * problem. Without this column next to the rate, the report cries
   * wolf on every segmentation change.
   */
  volume_ratio: number;
  /**
   * True when the publication is sending materially MORE than it was
   * (see VOLUME_CONFOUND_RATIO), which mechanically dilutes engagement
   * rates: freshly-acquired subscribers open less and newly-mailed
   * addresses bounce more, so some of the decline is arithmetic.
   *
   * These rows are damped rather than dropped. A workspace that
   * doubled its list AND lost 24 points of open rate may genuinely
   * have expanded badly — that is worth seeing, just not above a
   * publication degrading at flat volume.
   *
   * Note this is asymmetric on purpose. A volume DECREASE usually
   * means the publisher segmented down to engaged subscribers, which
   * should push engagement UP — so a decline on shrinking volume is
   * more alarming, not less, and is never damped.
   */
  volume_confounded: boolean;
  /** Only the metrics that cleared the surfacing bar, worst first. */
  metrics: MetricTrend[];
  severity: number;
}

export interface WorkspaceTrend {
  workspace_id: string;
  workspace_name: string | null;
  publications: PublicationTrend[];
  /** Max severity across this workspace's publications. */
  severity: number;
  /** One line for the row tooltip, e.g.
   *  "3 newsletters declining — delivery -2.5pt, open -12.2pt". */
  summary: string;
  /**
   * True when more than one publication in the workspace is declining
   * at once.
   *
   * Worth its own field because it is the strongest signal the report
   * produces and a per-post threshold can never see it. A single
   * newsletter slipping is usually a content or list problem; three
   * slipping together is a sending-domain or IP reputation problem at
   * the workspace level, and it needs a different conversation.
   */
  multi_publication: boolean;
}

export interface EngagementTrendReport {
  generated_at: string;
  recent_days: number;
  baseline_days: number;
  /** Publications examined, before the surfacing bar. Lets the UI say
   *  "12 of 4,088 declining" instead of an unanchored count. */
  publications_examined: number;
  workspaces: WorkspaceTrend[];
}

// ─── Clears ───────────────────────────────────────────────────────

/**
 * A dismissed warning.
 *
 * `severity_at_clear` is the load-bearing field. A deliverability
 * clear can be permanent because the next send is a new post_id and
 * trips fresh — but a trend is continuous, so a permanent clear would
 * silence a publication that goes on sliding for another ten points.
 * Storing the severity at dismissal lets the engine re-raise when
 * things get materially worse while staying quiet if they don't.
 */
export interface TrendClear {
  cleared_at: string;
  cleared_by?: string | null;
  reason?: string | null;
  severity_at_clear: number;
}

export type TrendClearMap = Record<string, TrendClear>;

/**
 * Volume growth past which engagement declines are treated as partly
 * mechanical. 1.4x is deliberately generous — normal week-to-week
 * send variation sits well inside it, so this only trips on real list
 * expansion.
 */
export const VOLUME_CONFOUND_RATIO = 1.4;

/**
 * Severity multiplier applied to a volume-confounded row.
 *
 * Halving rather than zeroing: in testing, one 115-newsletter local
 * network ranked 3rd in the whole book on a 14.7pt open-rate drop,
 * and its flagged publications had a MEDIAN volume ratio of 2.17 —
 * one had gone 9k to 27k recipients. Ranked at face value it would
 * have been the first thing a CSM saw and the fastest way to teach
 * them the report cries wolf.
 */
export const VOLUME_CONFOUND_DAMPING = 0.5;

/** How much worse a cleared workspace has to get before it comes
 *  back. Points of severity, not a ratio — a jump from 20 to 40
 *  matters as much as 60 to 80. */
export const TREND_RERAISE_SEVERITY_DELTA = 20;

/**
 * Hard expiry on a clear, regardless of severity.
 *
 * Needed because severity is capped at 100, so the +20 rule alone
 * cannot ever fire for anything dismissed above 80 — exactly the
 * worst declines would be the ones silenced permanently. A report
 * whose job is noticing slow degradation must not have a way to be
 * muted forever, so every clear ages out.
 *
 * 60 days is a bit over two baseline windows: long enough that
 * acknowledging something doesn't mean seeing it again next week,
 * short enough that a decline left unattended resurfaces.
 */
export const TREND_RERAISE_DAYS = 60;
