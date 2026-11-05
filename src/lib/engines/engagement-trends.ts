import { DB, runNativeQuery } from "../metabase";
import { isDemoMode } from "../demo/mode";
import { THRESHOLDS } from "../thresholds";
import {
  MIN_LISTS_FOR_MIX,
  MIN_WEEK_VOLUME_SHARE,
  MIX_CONFOUND_DAMPING,
  MIX_CONFOUND_SHARE,
  TREND_METRICS,
  TREND_METRIC_DIRECTION,
  TREND_METRIC_LABELS,
  VOLUME_CONFOUND_DAMPING,
  VOLUME_CONFOUND_RATIO,
  type EngagementTrendReport,
  type ListSplit,
  type MetricTrend,
  type PublicationTrend,
  type TrendMetric,
  type TrendPoint,
  type TrendWindow,
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
 * over Metabase's 2,000-row userland cap. `runNativeQuery` asks for
 * that cap to be lifted (middleware flag + `constraints: null`) and
 * PR #275 measured that it DOESN'T WORK: both documented escape
 * hatches set, `SELECT number FROM numbers(2500)` still returns 2,000
 * rows, with no error — the response simply stops.
 *
 * Silent truncation here would not throw; it would quietly drop a
 * third of the book out of the report, which is the worst possible
 * failure for a tool whose only job is noticing things. Sharding on
 * `cityHash64(publication_id) % 3` puts every response around 1,100
 * rows, for 13 weeks x 3 shards = 39 queries on a weekly sweep.
 *
 * The per-list sweep adds 2 windows x 8 shards = 16 more, plus one
 * date anchor and a handful of name lookups — call it 60 queries and
 * under three minutes. See LIST_SHARDS for why that one needs 8 where
 * the weekly series needs 3.
 *
 * `runNativeQueryUnlimited` (also from #275) is the other way out —
 * it goes through the export endpoint, which the cap doesn't apply
 * to, and would cut this to 13 queries. Not used here because the
 * sharded version is verified end-to-end against production and the
 * export path serializes some column types differently; a ~2 minute
 * weekly job is not worth re-validating for. Worth revisiting if the
 * window ever grows enough to make 39 queries uncomfortable.
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

// ─── Dates ────────────────────────────────────────────────────────

/**
 * Plain YYYY-MM-DD arithmetic in UTC.
 *
 * Deliberately not timezone-aware. Every offset in this engine is a
 * whole number of days against ClickHouse today(), so these are
 * calendar dates and nothing else; running them through a local
 * timezone is the only way to make them wrong.
 */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startIso: string, endIso: string): number {
  const a = Date.parse(`${startIso}T00:00:00Z`);
  const b = Date.parse(`${endIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

function windowOf(start: string, end: string): TrendWindow {
  return { start, end, days: daysBetween(start, end) };
}

/**
 * The date ClickHouse means by today().
 *
 * Asked rather than assumed. Every window in the SQL is today() - N
 * evaluated on the database server; this process may be in another
 * timezone or a few hours out, and labelling a 90-day window with the
 * wrong day is the specific failure this whole change exists to
 * prevent. One trivial query is cheap insurance.
 *
 * The sweep takes a couple of minutes and each query re-evaluates
 * today(), so a run straddling UTC midnight would label its later
 * weeks a day early. The cron fires at 13:00 UTC, which is as far
 * from that boundary as it gets, so this is noted and not defended
 * against.
 */
async function fetchAnchorDate(): Promise<string> {
  try {
    const rows = (await runNativeQuery(
      DB.CLICKHOUSE_ADHOC,
      "SELECT toString(today()) AS d"
    )) as unknown as Array<Record<string, unknown>>;
    const d = rows?.[0]?.d;
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  } catch (e) {
    console.error(
      "[trends] anchor date lookup failed, falling back to local clock:",
      e instanceof Error ? e.message : e
    );
  }
  return new Date().toISOString().slice(0, 10);
}

/** The inclusive dates week `weekIndex` covers, matching
 *  buildWeekSql() offset for offset. The SQL range is half-open at
 *  the top, so the inclusive end is one day earlier. */
function weekDates(anchor: string, weekIndex: number): {
  week_start: string;
  week_end: string;
} {
  const startOffset = TOTAL_DAYS - weekIndex * 7;
  const endOffset = Math.max(startOffset - 7, 0);
  return {
    week_start: addDays(anchor, -startOffset),
    week_end: addDays(anchor, -endOffset - 1),
  };
}

/**
 * The two windows as actually measured.
 *
 * Built from the week buckets rather than from RECENT_DAYS /
 * BASELINE_DAYS, because those two numbers are the design intent and
 * the buckets are the implementation. They do not quite agree: the
 * series is quantised to whole weeks and the split lands on a week
 * boundary, so the real windows are 63 baseline days and 27 recent
 * days against a nominal 62 and 28.
 *
 * That gap was invisible until these dates existed. It is reported
 * rather than corrected — moving the boundary would shift every rate
 * in the report, and a day either way does not change any conclusion
 * the report draws.
 */
function describeWindows(anchor: string): {
  baseline: TrendWindow;
  recent: TrendWindow;
  data_through: string;
} {
  const oldest = weekDates(anchor, 0);
  const lastBaseline = weekDates(anchor, RECENT_WEEK_START - 1);
  const firstRecent = weekDates(anchor, RECENT_WEEK_START);
  const newest = weekDates(anchor, WEEK_COUNT - 1);
  return {
    baseline: windowOf(oldest.week_start, lastBaseline.week_end),
    recent: windowOf(firstRecent.week_start, newest.week_end),
    data_through: newest.week_end,
  };
}

// ─── Newsletter-list splits ───────────────────────────────────────

/**
 * Shards for the per-list sweep.
 *
 * Higher than SHARDS because grouping by (publication, list) instead
 * of publication alone roughly triples the row count: the two windows
 * produce 8,862 and 8,686 publication-list pairs, which at 3 shards
 * peaks at 3,153 rows and silently loses everything past 2,000. At 8
 * the worst shard is about 1,250, leaving room for the book to grow
 * before this needs revisiting. Measured on 2026-11-04, not guessed.
 */
const LIST_SHARDS = 8;

/** Offsets that tile exactly onto the week buckets, so the list
 *  windows and the weekly series cover the same days. */
const RECENT_START_OFFSET = TOTAL_DAYS - RECENT_WEEK_START * 7;

interface ListWindowRow {
  publication_id: string;
  list_id: string;
  counts: Counts;
}

function buildListSql(
  startOffset: number,
  endOffset: number,
  shard: number
): string {
  // Three things here are load-bearing and look like they could be
  // simplified:
  //
  // 1. The IN (SELECT ...) stays, even though wk is also joined.
  //    It is what gives ClickHouse an index condition on the fact
  //    table; the join alone reproduces the 60s timeout described at
  //    the top of this file.
  //
  // 2. wk collapses to one row per post with argMax on the peerdb
  //    version. swarm_clickpipes mirrors are ReplacingMergeTree, so a
  //    post can appear once per ingested version. For the weekly
  //    series that is harmless because the subquery is only used for
  //    set membership, but here every duplicate would attribute the
  //    same send to a list a second time. FINAL would also fix it and
  //    costs far more over a table this size.
  //
  // 3. The shard predicate is applied in BOTH wk and the fact scan.
  //    It reads as redundant and is not: without it in wk, all eight
  //    shards rebuild the same full post set and the window costs
  //    eight scans of posts instead of one. Safe because a post's
  //    publication_id agrees with the fact table's — checked across
  //    169,583 posts on 2026-11-04, zero mismatches and no post
  //    appearing under two publications.
  return `
    WITH wk AS (
      SELECT pid, argMax(list_id, ver) AS list_id
      FROM (
        SELECT
          p.id                 AS pid,
          p.newsletter_list_id AS list_id,
          p._peerdb_version    AS ver
        FROM swarm_clickpipes.posts p
        JOIN swarm_clickpipes.publications pub ON pub.id = p.publication_id
        JOIN swarm_clickpipes.organizations o ON o.id = pub.organization_id
        WHERE o.plan_id = 8
          AND p.send_status = 2
          AND cityHash64(p.publication_id) % ${LIST_SHARDS} = ${shard}
          AND p.scheduled_at >= today() - ${startOffset}
          AND p.scheduled_at <  today() - ${endOffset}
      )
      GROUP BY pid
    ),
    fx AS (
      SELECT
        f.sendable_id                          AS pid,
        toString(f.publication_id)             AS publication_id,
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
        AND cityHash64(f.publication_id) % ${LIST_SHARDS} = ${shard}
        AND f.sendable_id IN (SELECT pid FROM wk)
      GROUP BY pid, publication_id
    )
    SELECT
      fx.publication_id    AS publication_id,
      toString(wk.list_id) AS list_id,
      sum(fx.sent)          AS sent,
      sum(fx.delivered)     AS delivered,
      sum(fx.opened)        AS opened,
      sum(fx.clicked)       AS clicked,
      sum(fx.hard_bounced)  AS hard_bounced,
      sum(fx.soft_bounced)  AS soft_bounced,
      sum(fx.spam_reported) AS spam_reported
    FROM fx
    INNER JOIN wk ON wk.pid = fx.pid
    GROUP BY publication_id, list_id
  `;
}

function countsFrom(r: Record<string, unknown>): Counts {
  return {
    sent: Number(r.sent) || 0,
    delivered: Number(r.delivered) || 0,
    opened: Number(r.opened) || 0,
    clicked: Number(r.clicked) || 0,
    hard_bounced: Number(r.hard_bounced) || 0,
    soft_bounced: Number(r.soft_bounced) || 0,
    spam_reported: Number(r.spam_reported) || 0,
  };
}

function emptyCounts(): Counts {
  return {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    hard_bounced: 0,
    soft_bounced: 0,
    spam_reported: 0,
  };
}

/** UUID zero is what ClickHouse gives for a post with no list. It is
 *  not a list id and must never be looked up as one. */
const NO_LIST_ID = "00000000-0000-0000-0000-000000000000";

interface ListWindows {
  baseline: Counts;
  recent: Counts;
}

async function fetchListWindow(
  startOffset: number,
  endOffset: number
): Promise<ListWindowRow[]> {
  const out: ListWindowRow[] = [];
  for (let shard = 0; shard < LIST_SHARDS; shard++) {
    try {
      const rows = (await runNativeQuery(
        DB.CLICKHOUSE_ADHOC,
        buildListSql(startOffset, endOffset, shard)
      )) as unknown as Array<Record<string, unknown>>;
      if (rows.length >= 2000) {
        console.warn(
          `[trends] list shard ${shard} (${startOffset}-${endOffset}d) returned ${rows.length} rows — at/above the 2000 cap; raise LIST_SHARDS.`
        );
      }
      for (const r of rows) {
        out.push({
          publication_id: String(r.publication_id),
          list_id: String(r.list_id),
          counts: countsFrom(r),
        });
      }
    } catch (e) {
      console.error(
        `[trends] list shard ${shard} (${startOffset}-${endOffset}d) failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return out;
}

/**
 * Per-publication, per-list totals for both windows.
 *
 * A failed shard degrades to "this publication has no list data",
 * which disables the mix adjustment for it rather than producing a
 * decomposition from half the lists — a partial split would read as
 * confident and be arbitrarily wrong.
 */
async function fetchListSplits(): Promise<
  Map<string, Map<string, ListWindows>>
> {
  const byPub = new Map<string, Map<string, ListWindows>>();

  const put = (
    row: ListWindowRow,
    which: "baseline" | "recent"
  ): void => {
    let lists = byPub.get(row.publication_id);
    if (!lists) {
      lists = new Map<string, ListWindows>();
      byPub.set(row.publication_id, lists);
    }
    let w = lists.get(row.list_id);
    if (!w) {
      w = { baseline: emptyCounts(), recent: emptyCounts() };
      lists.set(row.list_id, w);
    }
    const t = w[which];
    t.sent += row.counts.sent;
    t.delivered += row.counts.delivered;
    t.opened += row.counts.opened;
    t.clicked += row.counts.clicked;
    t.hard_bounced += row.counts.hard_bounced;
    t.soft_bounced += row.counts.soft_bounced;
    t.spam_reported += row.counts.spam_reported;
  };

  for (const r of await fetchListWindow(TOTAL_DAYS, RECENT_START_OFFSET)) {
    put(r, "baseline");
  }
  for (const r of await fetchListWindow(RECENT_START_OFFSET, 0)) {
    put(r, "recent");
  }
  return byPub;
}

/** Names for the real lists we are about to show. The no-list bucket
 *  is excluded — it has no row in `lists` and asking for it would
 *  return nothing while looking like a miss. */
async function fetchListNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const real = ids.filter((id) => id !== NO_LIST_ID);
  const CHUNK = 500;
  for (let i = 0; i < real.length; i += CHUNK) {
    const inList = real
      .slice(i, i + CHUNK)
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(",");
    if (!inList) continue;
    const sql = `
      SELECT toString(id) AS list_id, name AS list_name
      FROM (SELECT * FROM swarm_clickpipes.lists FINAL)
      WHERE id IN (${inList})
    `;
    try {
      const rows = (await runNativeQuery(
        DB.CLICKHOUSE_ADHOC,
        sql
      )) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) {
        const name = (r.list_name as string) || "";
        if (name) map.set(String(r.list_id), name);
      }
    } catch (e) {
      console.error(
        "[trends] fetchListNames chunk failed:",
        e instanceof Error ? e.message : e
      );
    }
  }
  return map;
}

/**
 * Shift-share decomposition of a metric's move.
 *
 * Returns what the delta would have been if the publication had kept
 * mailing each list in the same proportion as it did in the baseline
 * window — the within-list change — and, by subtraction, how much of
 * the observed move is the mix having shifted instead.
 *
 * Only lists that sent in BOTH windows contribute, weighted by their
 * baseline volume. That is what makes list churn fall out as mix: a
 * list that stopped sending has no recent rate to carry forward, so
 * its disappearance shows up in the observed delta and not in the
 * within-list one, which is exactly the attribution we want.
 *
 * Null when no list sent in both windows — there is then nothing to
 * hold constant and no honest adjustment to make.
 */
function decomposeMix(
  metric: TrendMetric,
  lists: Map<string, ListWindows>,
  observedDelta: number
): { adjusted: number | null; mix: number | null } {
  let weight = 0;
  let baseAcc = 0;
  let recentAcc = 0;
  for (const w of lists.values()) {
    const wb = denomOf(metric, w.baseline);
    if (wb <= 0) continue;
    const rb = rateOf(metric, w.baseline);
    const rr = rateOf(metric, w.recent);
    if (rb == null || rr == null) continue;
    weight += wb;
    baseAcc += wb * rb;
    recentAcc += wb * rr;
  }
  if (weight <= 0) return { adjusted: null, mix: null };
  const within = (recentAcc - baseAcc) / weight;
  return { adjusted: within, mix: observedDelta - within };
}

/** The per-list rows for the panel, biggest recent audience first. */
function buildListSplits(
  lists: Map<string, ListWindows>,
  names: Map<string, string>
): ListSplit[] {
  const out: ListSplit[] = [];
  for (const [list_id, w] of lists) {
    out.push({
      list_id,
      list_name: list_id === NO_LIST_ID ? null : (names.get(list_id) ?? null),
      recipients_recent: w.recent.sent,
      recipients_baseline: w.baseline.sent,
      open_rate_recent: rateOf("open_rate", w.recent),
      open_rate_baseline: rateOf("open_rate", w.baseline),
      is_new: w.baseline.sent === 0 && w.recent.sent > 0,
      is_dropped: w.recent.sent === 0 && w.baseline.sent > 0,
    });
  }
  out.sort(
    (a, b) =>
      b.recipients_recent - a.recipients_recent ||
      b.recipients_baseline - a.recipients_baseline
  );
  return out;
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

interface Counts {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  hard_bounced: number;
  soft_bounced: number;
  spam_reported: number;
}

/**
 * Denominators mirror lib/thresholds.ts: bounce rates are of SENT (a
 * bounce means it never arrived), engagement is of DELIVERED.
 *
 * Split out from rateOf() because the list-mix decomposition needs the
 * denominator on its own, as the weight each list contributes. Having
 * one function own the choice means a weighted average can never end
 * up weighting open rate by `sent` while rateOf divides by
 * `delivered` — a mismatch that would look plausible and be wrong by a
 * few points on exactly the publications with bounce problems.
 */
function denomOf(metric: TrendMetric, r: Counts): number {
  switch (metric) {
    case "delivery_rate":
    case "hard_bounce_rate":
    case "soft_bounce_rate":
      return r.sent;
    case "open_rate":
    case "click_rate":
    case "spam_rate":
      return r.delivered;
  }
}

function numerOf(metric: TrendMetric, r: Counts): number {
  switch (metric) {
    case "delivery_rate":
      return r.delivered;
    case "open_rate":
      return r.opened;
    case "click_rate":
      return r.clicked;
    case "hard_bounce_rate":
      return r.hard_bounced;
    case "soft_bounce_rate":
      return r.soft_bounced;
    case "spam_rate":
      return r.spam_reported;
  }
}

function rateOf(metric: TrendMetric, r: Counts): number | null {
  const d = denomOf(metric, r);
  return d > 0 ? numerOf(metric, r) / d : null;
}

/**
 * The highest and lowest weeks in a series, by value.
 *
 * The point of carrying these is that two numbers and an arrow cannot
 * tell you whether a fall was a cliff or a slide. "Open rate peaked at
 * 48.2% the week of 18 Aug and bottomed at 29.4% the week of 27 Oct"
 * is a sentence a CSM can take to a customer; "42.1% to 31.3%" is not.
 *
 * Magnitude, not health — see the comment on MetricTrend.high.
 */
function extremes(points: TrendPoint[]): {
  high: TrendPoint | null;
  low: TrendPoint | null;
} {
  if (points.length === 0) return { high: null, low: null };
  let high = points[0];
  let low = points[0];
  for (const pt of points) {
    if (pt.value > high.value) high = pt;
    if (pt.value < low.value) low = pt;
  }
  return { high, low };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ─── Scoring ──────────────────────────────────────────────────────

/** Window totals: the same counters as Counts plus how many sends
 *  produced them. Extends rather than restates so the two can never
 *  drift apart and quietly break rateOf(). */
interface Totals extends Counts {
  sends: number;
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

  const emptyAs = (anchor: string): EngagementTrendReport => {
    const w = describeWindows(anchor);
    return {
      generated_at,
      recent_days: RECENT_DAYS,
      baseline_days: BASELINE_DAYS,
      recent_window: w.recent,
      baseline_window: w.baseline,
      data_through: w.data_through,
      publications_examined: 0,
      workspaces: [],
    };
  };

  // Demo mode has no ClickHouse fixtures — same stance as the other
  // ClickHouse-backed engines, which render their empty state. The
  // local clock is good enough to date an empty report.
  if (isDemoMode()) return emptyAs(generated_at.slice(0, 10));

  // Anchor every date label to the database's own today(), which is
  // what the SQL offsets are relative to.
  const anchor = await fetchAnchorDate();
  const windows = describeWindows(anchor);

  const weeks = await fetchWeeklySeries();
  if (weeks.length === 0) return emptyAs(anchor);

  // Per-list splits for the two windows. Fetched after the weekly
  // series rather than alongside it: these are 16 more ClickHouse
  // queries and running both sweeps concurrently would double the
  // load on a cluster the rest of the company is also using, to save
  // about half a minute on a job with a six-hour window.
  const listSplits = await fetchListSplits();

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
    /** metric -> dated weekly series, oldest first */
    points: Map<TrendMetric, TrendPoint[]>;
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
    const points = new Map<TrendMetric, TrendPoint[]>();

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
      const dated: TrendPoint[] = [];
      // Floor for the DISPLAYED series only; xs/ys below still see
      // every week so the slope and the MAD keep the behaviour that
      // decides which publications are flagged.
      const medianWeekSent = median(series.map((r) => r.sent));
      const weekFloor = medianWeekSent * MIN_WEEK_VOLUME_SHARE;
      for (const r of series) {
        const v = rateOf(metric, r);
        if (v == null) continue;
        xs.push(r.week_index);
        ys.push(v);
        if (r.sent >= weekFloor) {
          const d = weekDates(anchor, r.week_index);
          dated.push({
            week_start: d.week_start,
            week_end: d.week_end,
            value: v,
          });
        }
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
      points.set(metric, dated);
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
      points,
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
    const pubLists = listSplits.get(s.publication_id) ?? null;

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
      const dated = s.points.get(metric) ?? [];
      const { high, low } = extremes(dated);

      // Mix is decomposed against the RAW delta, not the
      // cohort-adjusted one: the per-list arithmetic reconstructs the
      // publication's own move, and subtracting the cohort first
      // would leave a residual that is neither the publication's
      // within-list change nor anything else nameable.
      const { adjusted: mixAdjusted, mix } =
        pubLists != null && pubLists.size >= MIN_LISTS_FOR_MIX
          ? decomposeMix(metric, pubLists, delta)
          : { adjusted: null, mix: null };

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
        points: dated,
        high,
        low,
        mix_adjusted_delta: mixAdjusted,
        mix_delta: mix,
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

    // Mix is judged on the headline metric, because that is the one
    // driving severity and the one the summary line quotes. A lower
    // metric being mix-driven while the headline is not does not make
    // the row less worth looking at.
    const headline = metrics[0];
    const mixConfounded =
      headline.mix_delta != null &&
      Math.abs(headline.mix_delta) >=
        MIX_CONFOUND_SHARE * Math.abs(headline.delta);

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
      // Filled in below, once we know which publications survived and
      // can look up only those list names.
      lists: [],
      mix_confounded: mixConfounded,
      metrics,
      // The two dampings stack. A publication that both grew its list
      // and changed which lists it mails has two independent reasons
      // its rate could move without anything being wrong, and a
      // quarter severity is the right place for it.
      severity: Math.round(
        headline.severity *
          (confounded ? VOLUME_CONFOUND_DAMPING : 1) *
          (mixConfounded ? MIX_CONFOUND_DAMPING : 1)
      ),
    });
  }

  // ─── Names, then roll up to workspace ───
  const meta = await fetchPubMeta(pubTrends.map((p) => p.publication_id));

  // List names last, and only for publications that actually
  // surfaced — the sweep sees thousands of lists and the report shows
  // a few hundred.
  const listIds = new Set<string>();
  for (const p of pubTrends) {
    const ls = listSplits.get(p.publication_id);
    if (ls) for (const id of ls.keys()) listIds.add(id);
  }
  const listNames = await fetchListNames([...listIds]);
  for (const p of pubTrends) {
    const ls = listSplits.get(p.publication_id);
    if (ls) p.lists = buildListSplits(ls, listNames);
  }

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
    // "Clean" means neither confound applies. Mix joins dilution here
    // for the same reason dilution was added: a headline of "43
    // newsletters declining" is false about the world if 30 of them
    // are declining only because the publisher mailed a different set
    // of lists. Both are counted out of the headline and named
    // separately, so nothing is hidden.
    const clean = pubs.filter((p) => !p.volume_confounded && !p.mix_confounded);
    const dilutedCount = pubs.filter((p) => p.volume_confounded).length;
    const mixCount = pubs.filter(
      (p) => p.mix_confounded && !p.volume_confounded
    ).length;
    const headlineCount = clean.length > 0 ? clean.length : pubs.length;
    const scope =
      headlineCount > 1
        ? `${headlineCount} newsletters declining`
        : (pubs[0].publication_name ?? "1 newsletter") + " declining";
    const diluted =
      dilutedCount > 0
        ? ` (+${dilutedCount} more diluted by list growth)`
        : "";
    const mixed =
      mixCount > 0 ? ` (+${mixCount} more explained by list mix)` : "";
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
    // Same reasoning as the dilution note: a row that has been damped
    // for mix needs to say so, or it just looks oddly mid-ranked. The
    // within-list number is the useful one, so quote it rather than
    // only naming the problem.
    const within = pubs[0].metrics[0].mix_adjusted_delta;
    const mixNote =
      pubs[0].mix_confounded && within != null
        ? ` (mostly a list-mix change — within-list ${pts(within)})`
        : "";

    workspaces.push({
      workspace_id,
      workspace_name: pubs[0].workspace_name,
      publications: pubs,
      severity,
      summary: `${scope} — ${detail}${runway}${confound}${mixNote}${diluted}${mixed}`,
      // Clean count, for the same reason the headline uses it: three
      // publications sliding together only implies a shared sending
      // problem if the slide isn't just growth or a change in which
      // lists got mailed.
      multi_publication: clean.length > 1,
    });
  }

  workspaces.sort((a, b) => b.severity - a.severity);

  return {
    generated_at,
    recent_days: RECENT_DAYS,
    baseline_days: BASELINE_DAYS,
    recent_window: windows.recent,
    baseline_window: windows.baseline,
    data_through: windows.data_through,
    publications_examined: scored.length,
    workspaces,
  };
}
