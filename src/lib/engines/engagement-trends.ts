import { DB, runNativeQuery } from "../metabase";
import { isDemoMode } from "../demo/mode";
import { THRESHOLDS } from "../thresholds";
import {
  TREND_METRICS,
  TREND_METRIC_DIRECTION,
  TREND_METRIC_LABELS,
  VOLUME_CONFOUND_DAMPING,
  VOLUME_CONFOUND_RATIO,
  type EngagementTrendReport,
  type MetricTrend,
  type PublicationTrend,
  type TrendMetric,
  type WorkspaceTrend,
} from "./engagement-trends-types";

/**
 * Engagement Trend Engine
 * ------------------------
 * Finds publications whose deliverability/engagement is degrading
 * while still sitting inside the healthy bands — the blind spot
 * `lib/thresholds.ts` structurally cannot see. The rationale for the
 * whole report is in the header of `engagement-trends-types.ts`.
 *
 * ─── Why the queries look like this ───
 *
 * The obvious query — join `posts` to `fact_sendables_by_type_v1` and
 * GROUP BY week — TIMES OUT AT 60s. The fact table is a View over
 * something huge, and a join gives ClickHouse no index to seek with,
 * so it scans.
 *
 * What does work, in seconds, is the shape the deliverability engine
 * already discovered: filter the fact table by `sendable_id IN
 * (subquery)`. The subquery is evaluated to a set first and used as an
 * index condition. Keep that shape; a refactor back to a join will
 * look tidier and will not return.
 *
 * ─── Why it's sharded by publication hash ───
 *
 * One week of Enterprise sends touches ~3,300 publications, which is
 * over Metabase's default 2,000-row userland cap. `runNativeQuery`
 * does ask for that cap to be lifted (middleware flag + constraints:
 * null), but this repo has production evidence of the bypass being
 * ignored and responses silently clipping to exactly 2,000 rows — the
 * bug that hid a 79%-delivery send for a week.
 *
 * Silent truncation here would not throw; it would just quietly drop a
 * third of the book out of the report, which is the worst possible
 * failure for a tool whose job is noticing things. Sharding on
 * `cityHash64(publication_id) % 3` puts every response around 1,100
 * rows — comfortably under the cap even if the bypass fails — for 13
 * weeks x 3 shards = 39 queries on a scheduled sweep.
 */

// ─── Windows ──────────────────────────────────────────────────────

/** Last 28 days = "now". Four weeks of sends is enough to be stable
 *  for a weekly newsletter without being so long that a decline is
 *  two months old before it shows. */
export const RECENT_DAYS = 28;
/** The 62 days before that = "normal". ~9 weekly points, enough for a
 *  median and a MAD that aren't dominated by one send. */
export const BASELINE_DAYS = 62;
const TOTAL_DAYS = RECENT_DAYS + BASELINE_DAYS;
const WEEK_COUNT = Math.ceil(TOTAL_DAYS / 7);
const SHARDS = 3;

/** Below this many recipients in a window the rates are too noisy to
 *  mean anything. Matches the spirit of MIN_SENDS_FOR_FLAG in
 *  thresholds.ts, applied to the window rather than a single send. */
const MIN_RECIPIENTS_PER_WINDOW = 5_000;
/** Two weekly points can't establish a trend; this is the floor for
 *  both windows. */
const MIN_WEEKS_PER_WINDOW = 2;

/**
 * Smallest move worth a CSM's attention, in rate points, per metric.
 * Below this we don't care how statistically clean the signal is —
 * a 0.2pt delivery move is not a conversation.
 */
const MIN_EFFECT: Record<TrendMetric, number> = {
  delivery_rate: 0.01,
  open_rate: 0.03,
  click_rate: 0.01,
  hard_bounce_rate: 0.005,
  soft_bounce_rate: 0.01,
  spam_rate: 0.0005,
};

/** How far outside normal week-to-week variation the move has to sit.
 *  2 is the conventional "outside the noise" bar and, with ~9 baseline
 *  weeks, is about as tight as the MAD estimate can honestly support. */
const MIN_ROBUST_Z = 2;

/**
 * The band at which `analyzePost` STARTS firing — warning where the
 * metric has one, critical where it doesn't.
 *
 * Deliberately the warning band and not the critical one. This report
 * is the complement of the threshold alert, so the line that matters
 * is where the existing alert takes over, not where it escalates. An
 * earlier cut gated on critical and surfaced a newsletter at 18.8%
 * open rate — already tripping OPEN_WARN on every send, so the CSM
 * would have seen it in two places and learned nothing new the second
 * time.
 *
 * It is also the right target for the runway projection: "crosses
 * into alerting in ~3 weeks" is the sentence a CSM can act on.
 *
 * Click rate has no band at all — it has never been alerted on — so it
 * can trend and score, but never produces a runway.
 */
const ALERT_BAND: Record<TrendMetric, number | null> = {
  delivery_rate: THRESHOLDS.delivery_rate.warning,
  open_rate: THRESHOLDS.open_rate.warning,
  click_rate: null,
  hard_bounce_rate: THRESHOLDS.hard_bounce_rate.warning,
  soft_bounce_rate: THRESHOLDS.soft_bounce_rate.critical,
  spam_rate: THRESHOLDS.spam_rate.warning,
};

// ─── Raw weekly rows ──────────────────────────────────────────────

interface WeekRow {
  publication_id: string;
  /** Index into the week series; 0 is the oldest week in the window. */
  week_index: number;
  sends: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  hard_bounced: number;
  soft_bounced: number;
  spam_reported: number;
}

function buildWeekSql(weekIndex: number, shard: number): string {
  // Week 0 is the OLDEST, so offsets count down from TOTAL_DAYS.
  const startOffset = TOTAL_DAYS - weekIndex * 7;
  const endOffset = Math.max(startOffset - 7, 0);
  return `
    WITH wk AS (
      SELECT p.id AS pid
      FROM swarm_clickpipes.posts p
      JOIN swarm_clickpipes.publications pub ON pub.id = p.publication_id
      JOIN swarm_clickpipes.organizations o ON o.id = pub.organization_id
      WHERE o.plan_id = 8
        AND p.send_status = 2
        AND p.scheduled_at >= today() - ${startOffset}
        AND p.scheduled_at <  today() - ${endOffset}
    )
    SELECT
      toString(f.publication_id)             AS publication_id,
      ${weekIndex}                           AS week_index,
      count()                                AS sends,
      sum(f.unique_subscriber_sent)          AS sent,
      sum(f.unique_subscriber_delivered)     AS delivered,
      sum(f.unique_subscriber_opened)        AS opened,
      sum(f.unique_subscriber_clicked)       AS clicked,
      sum(f.unique_subscriber_hard_bounced)  AS hard_bounced,
      sum(f.unique_subscriber_soft_bounced)  AS soft_bounced,
      sum(f.unique_subscriber_spam_reported) AS spam_reported
    FROM default.fact_sendables_by_type_v1 f
    WHERE f.sendable_type = 'Post'
      AND f.message_type = 'campaign'
      AND cityHash64(f.publication_id) % ${SHARDS} = ${shard}
      AND f.sendable_id IN (SELECT pid FROM wk)
    GROUP BY publication_id
  `;
}

async function fetchWeeklySeries(): Promise<WeekRow[]> {
  const out: WeekRow[] = [];
  for (let week = 0; week < WEEK_COUNT; week++) {
    for (let shard = 0; shard < SHARDS; shard++) {
      try {
        const rows = (await runNativeQuery(
          DB.CLICKHOUSE_ADHOC,
          buildWeekSql(week, shard)
        )) as unknown as Array<Record<string, unknown>>;
        if (rows.length >= 2000) {
          // The cap this sharding exists to avoid. Loud, because the
          // failure is silent data loss rather than an error.
          console.warn(
            `[trends] week ${week} shard ${shard} returned ${rows.length} rows — at/above the 2000 cap; raise SHARDS.`
          );
        }
        for (const r of rows) {
          out.push({
            publication_id: String(r.publication_id),
            week_index: Number(r.week_index),
            sends: Number(r.sends) || 0,
            sent: Number(r.sent) || 0,
            delivered: Number(r.delivered) || 0,
            opened: Number(r.opened) || 0,
            clicked: Number(r.clicked) || 0,
            hard_bounced: Number(r.hard_bounced) || 0,
            soft_bounced: Number(r.soft_bounced) || 0,
            spam_reported: Number(r.spam_reported) || 0,
          });
        }
      } catch (e) {
        // Per-slice isolation, same as the deliverability engine: one
        // failed shard shouldn't blackhole the whole sweep. A missing
        // week just weakens that publication's series.
        console.error(
          `[trends] week ${week} shard ${shard} failed:`,
          e instanceof Error ? e.message : e
        );
      }
    }
  }
  return out;
}

// ─── Names ────────────────────────────────────────────────────────

interface PubMeta {
  publication_name: string | null;
  workspace_id: string;
  workspace_name: string | null;
}

/**
 * Publication + workspace names for the publications we scored.
 *
 * FINAL is not optional here. `swarm_clickpipes` mirrors are
 * ReplacingMergeTree, so without it one publication comes back once
 * per ingested version — a 7-publication lookup returned 78 rows in
 * testing, with a single org appearing under two different names
 * (an old one and its current one). q10600 uses FINAL for the same
 * reason.
 */
async function fetchPubMeta(pubIds: string[]): Promise<Map<string, PubMeta>> {
  const map = new Map<string, PubMeta>();
  const CHUNK = 500;
  for (let i = 0; i < pubIds.length; i += CHUNK) {
    const inList = pubIds
      .slice(i, i + CHUNK)
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(",");
    const sql = `
      SELECT
        toString(pub.id)   AS publication_id,
        pub.name           AS publication_name,
        toString(o.id)     AS workspace_id,
        o.name             AS workspace_name
      FROM (SELECT * FROM swarm_clickpipes.publications FINAL) pub
      JOIN (SELECT * FROM swarm_clickpipes.organizations FINAL) o
        ON o.id = pub.organization_id
      WHERE pub.id IN (${inList})
    `;
    try {
      const rows = (await runNativeQuery(DB.CLICKHOUSE_ADHOC, sql)) as unknown as Array<
        Record<string, unknown>
      >;
      for (const r of rows) {
        map.set(String(r.publication_id), {
          publication_name: (r.publication_name as string) || null,
          workspace_id: String(r.workspace_id),
          workspace_name: (r.workspace_name as string) || null,
        });
      }
    } catch (e) {
      console.error(
        "[trends] fetchPubMeta chunk failed:",
        e instanceof Error ? e.message : e
      );
    }
  }
  return map;
}

// ─── Statistics ───────────────────────────────────────────────────

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Normal-consistent median absolute deviation. The 1.4826 factor
 *  makes it comparable to a standard deviation for normal data, so
 *  `robust_z` reads on the familiar scale. */
function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/** OLS slope of y against x. Returns 0 when x has no spread. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function rateOf(metric: TrendMetric, r: {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  hard_bounced: number;
  soft_bounced: number;
  spam_reported: number;
}): number | null {
  // Denominators mirror lib/thresholds.ts: bounce rates are of SENT
  // (a bounce means it never arrived), engagement is of DELIVERED.
  switch (metric) {
    case "delivery_rate":
      return r.sent > 0 ? r.delivered / r.sent : null;
    case "open_rate":
      return r.delivered > 0 ? r.opened / r.delivered : null;
    case "click_rate":
      return r.delivered > 0 ? r.clicked / r.delivered : null;
    case "hard_bounce_rate":
      return r.sent > 0 ? r.hard_bounced / r.sent : null;
    case "soft_bounce_rate":
      return r.sent > 0 ? r.soft_bounced / r.sent : null;
    case "spam_rate":
      return r.delivered > 0 ? r.spam_reported / r.delivered : null;
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * First week index that counts as "recent".
 *
 * Week 0 is the OLDEST in the series and each week is 7 days, so week
 * w covers offsets [TOTAL_DAYS - 7w, TOTAL_DAYS - 7(w+1)). The recent
 * window is the last RECENT_DAYS, which is every week from
 * ceil(BASELINE_DAYS / 7) onward. Rounding UP matters: floor() would
 * pull week 8 (days 34-28 ago) into "recent" and silently widen the
 * window past RECENT_DAYS.
 */
const RECENT_WEEK_START = Math.ceil(BASELINE_DAYS / 7);

// ─── Scoring ──────────────────────────────────────────────────────

interface Totals {
  sends: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  hard_bounced: number;
  soft_bounced: number;
  spam_reported: number;
}

function emptyTotals(): Totals {
  return {
    sends: 0,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    hard_bounced: 0,
    soft_bounced: 0,
    spam_reported: 0,
  };
}

function addWeek(t: Totals, w: WeekRow): void {
  t.sends += w.sends;
  t.sent += w.sent;
  t.delivered += w.delivered;
  t.opened += w.opened;
  t.clicked += w.clicked;
  t.hard_bounced += w.hard_bounced;
  t.soft_bounced += w.soft_bounced;
  t.spam_reported += w.spam_reported;
}

/** Signed so that POSITIVE always means "worse", whichever direction
 *  the metric runs. Keeps every comparison downstream direction-free. */
function worseness(metric: TrendMetric, delta: number): number {
  return TREND_METRIC_DIRECTION[metric] === "lower_is_worse" ? -delta : delta;
}

/**
 * Weeks until `recent` crosses `threshold` at the current slope.
 *
 * null when the metric isn't heading there — flat, improving, already
 * past it, or no threshold at all. Capped at 104 weeks because "it
 * crosses in 9 years" is arithmetic, not a warning.
 */
function weeksToThreshold(
  metric: TrendMetric,
  recent: number,
  slopePer30d: number
): number | null {
  const threshold = ALERT_BAND[metric];
  if (threshold == null) return null;
  const closing = worseness(metric, slopePer30d);
  if (closing <= 0) return null;
  const gap = Math.abs(recent - threshold);
  const alreadyPast =
    TREND_METRIC_DIRECTION[metric] === "lower_is_worse"
      ? recent <= threshold
      : recent >= threshold;
  if (alreadyPast) return 0;
  const weeks = (gap / closing) * (30 / 7);
  return weeks > 104 ? null : Math.round(weeks * 10) / 10;
}

function scoreMetric(
  metric: TrendMetric,
  adjustedDelta: number,
  robustZ: number,
  weeks: number | null
): number {
  const magnitude = clamp01(
    Math.abs(adjustedDelta) / (3 * MIN_EFFECT[metric])
  );
  const consistency = clamp01(Math.abs(robustZ) / 4);
  // 26 weeks because half a year of runway is where "keep an eye on
  // it" turns into "do something this quarter".
  const urgency = weeks == null ? 0 : clamp01(1 - weeks / 26);
  return Math.round(100 * (0.4 * magnitude + 0.25 * consistency + 0.35 * urgency));
}

function pts(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;
}

// ─── Engine ───────────────────────────────────────────────────────

export async function runEngagementTrends(): Promise<EngagementTrendReport> {
  const generated_at = new Date().toISOString();
  const empty: EngagementTrendReport = {
    generated_at,
    recent_days: RECENT_DAYS,
    baseline_days: BASELINE_DAYS,
    publications_examined: 0,
    workspaces: [],
  };

  // Demo mode has no ClickHouse fixtures — same stance as the other
  // ClickHouse-backed engines, which render their empty state.
  if (isDemoMode()) return empty;

  const weeks = await fetchWeeklySeries();
  if (weeks.length === 0) return empty;

  // ─── Group the weekly series by publication ───
  const byPub = new Map<string, WeekRow[]>();
  for (const w of weeks) {
    const list = byPub.get(w.publication_id);
    if (list) list.push(w);
    else byPub.set(w.publication_id, [w]);
  }

  // ─── Per-publication window aggregates + series ───
  interface Scored {
    publication_id: string;
    recentTotals: Totals;
    baselineTotals: Totals;
    recentWeeks: number;
    baselineWeeks: number;
    /** metric -> raw delta (recent - baseline) */
    deltas: Map<TrendMetric, number>;
    /** metric -> robust z */
    zs: Map<TrendMetric, number>;
    /** metric -> slope per 30d */
    slopes: Map<TrendMetric, number>;
    recentRates: Map<TrendMetric, number>;
    baselineRates: Map<TrendMetric, number>;
  }

  const scored: Scored[] = [];

  for (const [publication_id, rows] of byPub) {
    const recentTotals = emptyTotals();
    const baselineTotals = emptyTotals();
    let recentWeeks = 0;
    let baselineWeeks = 0;
    for (const r of rows) {
      if (r.week_index >= RECENT_WEEK_START) {
        addWeek(recentTotals, r);
        recentWeeks++;
      } else {
        addWeek(baselineTotals, r);
        baselineWeeks++;
      }
    }

    // Volume + coverage floors. Everything below this line assumes the
    // rates mean something.
    if (
      recentWeeks < MIN_WEEKS_PER_WINDOW ||
      baselineWeeks < MIN_WEEKS_PER_WINDOW ||
      recentTotals.sent < MIN_RECIPIENTS_PER_WINDOW ||
      baselineTotals.sent < MIN_RECIPIENTS_PER_WINDOW
    ) {
      continue;
    }

    const deltas = new Map<TrendMetric, number>();
    const zs = new Map<TrendMetric, number>();
    const slopes = new Map<TrendMetric, number>();
    const recentRates = new Map<TrendMetric, number>();
    const baselineRates = new Map<TrendMetric, number>();

    for (const metric of TREND_METRICS) {
      const recent = rateOf(metric, recentTotals);
      const baseline = rateOf(metric, baselineTotals);
      if (recent == null || baseline == null) continue;

      // Weekly series, used for volatility and slope only — the
      // headline rates above stay volume-weighted so a tiny week
      // can't swing them.
      const series = [...rows].sort((a, b) => a.week_index - b.week_index);
      const baselinePoints: number[] = [];
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of series) {
        const v = rateOf(metric, r);
        if (v == null) continue;
        xs.push(r.week_index);
        ys.push(v);
        if (r.week_index < RECENT_WEEK_START) baselinePoints.push(v);
      }

      const spread = mad(baselinePoints);
      // A spread of 0 means every baseline week was identical — either
      // genuinely flat or too few points. Fall back to the metric's
      // minimum effect so robust_z stays finite and the move still has
      // to clear a real bar rather than dividing by ~0 and scoring
      // infinite.
      const denom = spread > 0 ? spread : MIN_EFFECT[metric];

      deltas.set(metric, recent - baseline);
      zs.set(metric, (recent - baseline) / denom);
      slopes.set(metric, slope(xs, ys) * (30 / 7));
      recentRates.set(metric, recent);
      baselineRates.set(metric, baseline);
    }

    scored.push({
      publication_id,
      recentTotals,
      baselineTotals,
      recentWeeks,
      baselineWeeks,
      deltas,
      zs,
      slopes,
      recentRates,
      baselineRates,
    });
  }

  // ─── Cohort move per metric ───
  //
  // Median of per-publication deltas, NOT a volume-weighted global
  // rate. One 17M-recipient newsletter would otherwise define "the
  // cohort" single-handedly, and what we want is what the TYPICAL
  // publication did.
  const cohortDelta = new Map<TrendMetric, number>();
  for (const metric of TREND_METRICS) {
    const ds: number[] = [];
    for (const s of scored) {
      const d = s.deltas.get(metric);
      if (d != null) ds.push(d);
    }
    cohortDelta.set(metric, ds.length > 0 ? median(ds) : 0);
  }

  // ─── Build the surfaced rows ───
  const pubTrends: PublicationTrend[] = [];

  for (const s of scored) {
    const metrics: MetricTrend[] = [];

    for (const metric of TREND_METRICS) {
      const recent = s.recentRates.get(metric);
      const baseline = s.baselineRates.get(metric);
      const delta = s.deltas.get(metric);
      const z = s.zs.get(metric);
      const slopePer30d = s.slopes.get(metric);
      if (
        recent == null ||
        baseline == null ||
        delta == null ||
        z == null ||
        slopePer30d == null
      ) {
        continue;
      }

      const cohort = cohortDelta.get(metric) ?? 0;
      const adjusted = delta - cohort;

      // Must be worse than the cohort by at least the minimum effect…
      if (worseness(metric, adjusted) < MIN_EFFECT[metric]) continue;
      // …and outside this publication's own normal variation…
      if (Math.abs(z) < MIN_ROBUST_Z) continue;

      // …and NOT already inside the alerting band. Past that line the
      // deliverability alert owns it; surfacing it here too would just
      // split attention across two screens.
      const threshold = ALERT_BAND[metric];
      if (threshold != null) {
        const breached =
          TREND_METRIC_DIRECTION[metric] === "lower_is_worse"
            ? recent < threshold
            : recent > threshold;
        if (breached) continue;
      }

      const weeks = weeksToThreshold(metric, recent, slopePer30d);
      metrics.push({
        metric,
        recent,
        baseline,
        delta,
        cohort_adjusted_delta: adjusted,
        cohort_delta: cohort,
        robust_z: z,
        slope_per_30d: slopePer30d,
        threshold,
        weeks_to_threshold: weeks,
        severity: scoreMetric(metric, adjusted, z, weeks),
      });
    }

    if (metrics.length === 0) continue;
    metrics.sort((a, b) => b.severity - a.severity);

    // Per-day rates, so a window-length difference doesn't read as a
    // volume change.
    const recentPerDay = s.recentTotals.sent / RECENT_DAYS;
    const baselinePerDay = s.baselineTotals.sent / BASELINE_DAYS;
    const volumeRatio =
      baselinePerDay > 0
        ? Math.round((recentPerDay / baselinePerDay) * 100) / 100
        : 1;
    const confounded = volumeRatio >= VOLUME_CONFOUND_RATIO;

    pubTrends.push({
      publication_id: s.publication_id,
      publication_name: null,
      workspace_id: "",
      workspace_name: null,
      sends_recent: s.recentTotals.sends,
      sends_baseline: s.baselineTotals.sends,
      recipients_recent: s.recentTotals.sent,
      recipients_baseline: s.baselineTotals.sent,
      volume_ratio: volumeRatio,
      volume_confounded: confounded,
      metrics,
      severity: confounded
        ? Math.round(metrics[0].severity * VOLUME_CONFOUND_DAMPING)
        : metrics[0].severity,
    });
  }

  // ─── Names, then roll up to workspace ───
  const meta = await fetchPubMeta(pubTrends.map((p) => p.publication_id));

  const byWorkspace = new Map<string, PublicationTrend[]>();
  for (const p of pubTrends) {
    const m = meta.get(p.publication_id);
    if (!m) continue; // No workspace to attribute it to — drop it.
    p.publication_name = m.publication_name;
    p.workspace_id = m.workspace_id;
    p.workspace_name = m.workspace_name;
    const list = byWorkspace.get(m.workspace_id);
    if (list) list.push(p);
    else byWorkspace.set(m.workspace_id, [p]);
  }

  const workspaces: WorkspaceTrend[] = [];
  for (const [workspace_id, pubs] of byWorkspace) {
    pubs.sort((a, b) => b.severity - a.severity);
    const severity = pubs[0].severity;

    // Headline: the worst metric, plus how wide the problem is. Worth
    // saying "3 newsletters" up front — one slipping is usually
    // content or list hygiene, three slipping together is a sending
    // domain or IP reputation problem and a different conversation.
    //
    // The count is of CLEAN publications only. A local-news network in
    // testing had 115 flagged, but 73 of those were list growth
    // diluting the rate — headlining "115 newsletters declining" would
    // have been true of the data and false about the world. The
    // diluted ones are still named, just counted separately.
    const worst = pubs[0].metrics[0];
    const clean = pubs.filter((p) => !p.volume_confounded);
    const dilutedCount = pubs.length - clean.length;
    const headlineCount = clean.length > 0 ? clean.length : pubs.length;
    const scope =
      headlineCount > 1
        ? `${headlineCount} newsletters declining`
        : (pubs[0].publication_name ?? "1 newsletter") + " declining";
    const diluted =
      dilutedCount > 0
        ? ` (+${dilutedCount} more diluted by list growth)`
        : "";
    const detail = `${TREND_METRIC_LABELS[worst.metric]} ${pts(worst.delta)}`;
    const runway =
      worst.weeks_to_threshold != null
        ? ` — crosses threshold in ~${worst.weeks_to_threshold}w`
        : "";
    // Say so in the headline. A damped row that looks merely
    // mid-ranked is confusing; one labelled "sending 2.2x more" tells
    // the CSM both why it is here and why it is not at the top.
    const confound = pubs[0].volume_confounded
      ? ` (sending ${pubs[0].volume_ratio}x more — partly dilution)`
      : "";

    workspaces.push({
      workspace_id,
      workspace_name: pubs[0].workspace_name,
      publications: pubs,
      severity,
      summary: `${scope} — ${detail}${runway}${confound}${diluted}`,
      // Clean count, for the same reason the headline uses it: three
      // publications sliding together only implies a shared sending
      // problem if the slide isn't just growth.
      multi_publication: clean.length > 1,
    });
  }

  workspaces.sort((a, b) => b.severity - a.severity);

  return {
    generated_at,
    recent_days: RECENT_DAYS,
    baseline_days: BASELINE_DAYS,
    publications_examined: scored.length,
    workspaces,
  };
}
