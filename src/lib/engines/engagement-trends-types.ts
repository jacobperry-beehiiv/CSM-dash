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

/**
 * Decimal places each metric needs before it says anything.
 *
 * Spam and bounce rates live near zero: a spam rate going 0.012% to
 * 0.058% is a fivefold rise and a real conversation, and at one
 * decimal both ends render as "0.0%" and the move as "+0.0pt". A
 * number rounded to nothing is worse than no number, because it looks
 * like it was checked.
 */
export const TREND_METRIC_DECIMALS: Record<TrendMetric, number> = {
  delivery_rate: 1,
  open_rate: 1,
  click_rate: 2,
  hard_bounce_rate: 2,
  soft_bounce_rate: 2,
  spam_rate: 3,
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

// ─── Dates ────────────────────────────────────────────────────────

/**
 * An inclusive date range, as plain YYYY-MM-DD strings.
 *
 * Why this is on the report at all: every window in this engine is
 * expressed to ClickHouse as `today() - N`, so the dates it actually
 * measured are a property of WHEN THE SWEEP RAN, not of when someone
 * opens the dashboard. The sweep is weekly, so by Friday "the last 28
 * days" on screen is a window that ended the previous Monday. Reading
 * a rate without knowing which days produced it is how a CSM ends up
 * telling a customer their open rate dropped last week when the data
 * stops eight days ago.
 *
 * Derived from the same offset arithmetic the SQL uses rather than
 * from RECENT_DAYS / BASELINE_DAYS, so what is displayed is what was
 * measured. Those two disagree slightly on purpose — see
 * describeWindows() in the engine.
 */
export interface TrendWindow {
  /** First day included, inclusive. */
  start: string;
  /** Last day included, inclusive. */
  end: string;
  /** end - start + 1. Spelled out so the UI never has to parse dates
   *  to say "63 days". */
  days: number;
}

/**
 * One week of the series, with the dates that produced it.
 *
 * The engine already computed this series to get a slope and a MAD and
 * then threw it away, which left the panel showing two numbers with an
 * arrow between them and no way to tell whether the fall was a cliff
 * in one week or a steady slide over three months. Keeping the points
 * costs a few KB in the snapshot and is what makes the peak and the
 * trough quotable.
 */
export interface TrendPoint {
  /** First day of the week bucket, inclusive. */
  week_start: string;
  /** Last day of the week bucket, inclusive. */
  week_end: string;
  value: number;
}

// ─── Newsletter lists ─────────────────────────────────────────────

/**
 * One newsletter list's slice of a publication's sends.
 *
 * `posts.newsletter_list_id` is the only place the send target is
 * recorded; the fact table is aggregated per post and carries no list
 * dimension at all, so this has to be reconstructed by joining posts
 * back to their rows.
 *
 * This matters because a beehiiv "publication" is frequently not one
 * newsletter. One publisher in the book fans a single publication out
 * across 19 lists whose open rates run from 20.8% to 69.4%, and
 * another across 20+ lists from 23.9% to 69.8%. Averaging those into a
 * single publication-level open rate and then watching it move is how
 * you mistake a change in WHAT THEY SENT for a change in how their
 * email is performing.
 */
export interface ListSplit {
  list_id: string;
  /** Null for sends with no list attached — rendered as
   *  NO_LIST_LABEL, not as an empty name. 44% of Enterprise posts in
   *  the last 90 days have no list, so this bucket is normal and
   *  often the largest one. */
  list_name: string | null;
  recipients_recent: number;
  recipients_baseline: number;
  /** Open rate in each window, null when that window had no delivered
   *  mail for this list. */
  open_rate_recent: number | null;
  open_rate_baseline: number | null;
  /** Sent in the recent window only. */
  is_new: boolean;
  /**
   * Sent in the baseline window only.
   *
   * Read this as "did not send recently", NOT as "deleted". A list on
   * a six-week cadence legitimately misses a 27-day recent window, and
   * 30% of publications have at least one such list. It is a flag for
   * interpreting the mix number, never a claim about the customer's
   * configuration.
   */
  is_dropped: boolean;
}

/** What to call the no-list bucket in the UI. */
export const NO_LIST_LABEL = "Untargeted sends";

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

  /**
   * The weekly series behind `delta`, oldest first, with the dates
   * each week covers. Weeks with no send are simply absent, so this
   * is not always WEEK_COUNT long and the gaps are real.
   */
  points: TrendPoint[];
  /**
   * The highest and lowest weeks in `points`, by VALUE — not by
   * health.
   *
   * An earlier cut resolved these for direction, so `best` meant the
   * lowest spam rate. Printed, that produced "peak 0.000% - low
   * 0.100%", which inverts what those two words mean to anyone
   * reading quickly. Plain magnitude is unambiguous, and the metric
   * name plus the signed delta already say which end is the good one.
   *
   * Null only when the series is empty.
   */
  high: TrendPoint | null;
  low: TrendPoint | null;

  /**
   * `delta` with the publication's newsletter-list mix held at its
   * baseline weights — i.e. what the move would have been if they had
   * sent the same proportion to each list as before.
   *
   * This is the honest degradation number. The raw `delta` moves when
   * a publisher drops a high-opening list or launches a low-opening
   * one, neither of which is a deliverability problem.
   *
   * Null when the publication has only one send target, or the list
   * sweep returned nothing for it — in which case there is no mix to
   * hold constant and `delta` is already the within-list number.
   */
  mix_adjusted_delta: number | null;
  /**
   * `delta - mix_adjusted_delta`: the part of the move attributable to
   * the mix changing rather than to any list getting worse.
   *
   * Kept next to the adjusted figure rather than inferred, so the UI
   * can say "of the -11.4pt, -8.9pt is them mailing different lists"
   * without redoing the subtraction and rounding differently.
   */
  mix_delta: number | null;
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
  /**
   * Per-newsletter-list breakdown over the two windows, biggest
   * recent volume first. Empty when the list sweep found nothing for
   * this publication.
   */
  lists: ListSplit[];
  /**
   * True when most of the headline move is the list mix changing
   * rather than any list degrading (see MIX_CONFOUND_SHARE).
   *
   * Measured rather than assumed, because the obvious worry turns out
   * to be the wrong one. Across 1,408 multi-list publications, mix
   * shift between lists that sent in BOTH windows moves the
   * publication open rate by a median of 0.01pt — it is nothing.
   * Where it bites is list CHURN: of 771 publications down 3pt or
   * more, 159 had lost a fifth of their baseline volume to a list
   * that stopped sending and 36 had gained a fifth from a new one.
   * That is a quarter of the declining set, which is far too many to
   * leave unlabelled.
   *
   * Damped like `volume_confounded` rather than dropped: a publisher
   * who quietly stopped mailing their best-performing list is still
   * something a CSM wants to know, it just is not a deliverability
   * fire.
   */
  mix_confounded: boolean;
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
  /**
   * The dates actually measured, resolved against the database clock
   * at sweep time. Prefer these over recent_days/baseline_days for
   * anything shown to a human: those two are the nominal window
   * lengths and the real windows are quantised to whole weeks, so
   * they differ by a day either way.
   */
  recent_window: TrendWindow;
  baseline_window: TrendWindow;
  /** Last day with data in it. Everything on the report stops here,
   *  which is NOT the same day the snapshot was generated and is
   *  several days before anyone reads it. */
  data_through: string;
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
 * A week must carry at least this share of the publication's own
 * median weekly volume to be quotable as a high or a low.
 *
 * Without it the extremes are drawn from test sends. One publication
 * in the book reported "peak 100.00% open rate" for a week in which a
 * handful of addresses got a send and every one of them opened it —
 * arithmetically true, useless to quote at a customer, and corrosive
 * to trust in every other number on the panel.
 *
 * Scale-relative rather than an absolute floor, because the book runs
 * from publications barely clearing MIN_RECIPIENTS_PER_WINDOW to ones
 * sending millions a week, and no single recipient count reads as
 * "trivial" for both.
 *
 * Applied ONLY to the displayed series. The slope and the MAD still
 * see every week, deliberately: those decide which publications get
 * flagged at all, and this change is not meant to move that line.
 */
export const MIN_WEEK_VOLUME_SHARE = 0.1;

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

/**
 * Share of the headline move that has to come from the list mix
 * before the row is labelled mix-confounded.
 *
 * Half, because that is the point where "this publication is getting
 * worse" stops being the better description of the data than "this
 * publication is mailing different people". Below it the mix is a
 * footnote; above it, it is the story.
 */
export const MIX_CONFOUND_SHARE = 0.5;

/**
 * Severity multiplier for a mix-confounded row.
 *
 * Same value and same reasoning as VOLUME_CONFOUND_DAMPING, and the
 * two stack: a publication that both grew its list and changed which
 * lists it mails ends up at a quarter severity, which is right. Those
 * are the two ways the number can move without anything being wrong.
 */
export const MIX_CONFOUND_DAMPING = 0.5;

/**
 * Minimum distinct send targets before "mix" means anything.
 *
 * Two, counting the no-list bucket as one of them. A publication that
 * only ever sends to one place has no mix to shift, and running the
 * decomposition on it would produce a confident zero that implies we
 * checked something we did not.
 */
export const MIN_LISTS_FOR_MIX = 2;

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
