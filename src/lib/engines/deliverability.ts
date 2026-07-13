import { DB, runNativeQuery } from "../metabase";
import { loadCustomers } from "../data/load-customers";
import { readDeliverabilitySnapshot } from "../data/deliverability-snapshot";
import { loadClearedPosts } from "../data/deliverability-clears";
import { analyzePost } from "../thresholds";
import type {
  DeliverabilityAlert,
  PostMetricsRow,
} from "../types";

/**
 * Enterprise Deliverability Alert Engine
 * ---------------------------------------
 * Ports the core data pipeline from the CSM plugin's
 * `enterprise-deliverability-alert` skill so it can run without Claude.
 *
 * Pipeline (matches Step 3A of the skill):
 *   Q1 — Fetch plan_id=8 posts sent in the last N days (ClickHouse 199)
 *   Q2 — Email metrics per post (fact_sendables_by_type_v1)
 *   Q3 — Unsubs per post (state_events_unsubscribe_post_id)
 *   Q4 — Spam/FBL per post (sendgrid_v1)
 *
 * The split-query approach is required: correlated subqueries against
 * fact_sendables / sendgrid are full-table scans and hit Metabase's 60s
 * timeout. Running Q1 first and passing a literal IN (…) list into
 * Q2/Q3/Q4 lets ClickHouse use the primary key index (sub-5s).
 *
 * We filter Q1's results to "yesterday only" before applying thresholds,
 * matching the daily-alert cadence.
 */

const LOOKBACK_DAYS = 15;

interface Q1Row {
  post_id: string;
  publication_id: string;
  newsletter: string;
  organization_id: string;
  workspace_name: string;
  sent_date: string;
  subject: string;
}

interface Q2Row {
  sendable_id: string;
  unique_subscriber_sent: number;
  unique_subscriber_delivered: number;
  unique_subscriber_opened: number;
  unique_subscriber_clicked: number;
  unique_subscriber_hard_bounced: number;
  unique_subscriber_soft_bounced: number;
}

interface Q3Row {
  unsubscribe_post_id: string;
  unsubs: number;
}

interface Q4Row {
  sendable_id: string;
  spam_reports: number;
}

/**
 * Q1 — fetch posts sent in the last N days for the orgs in our CSM
 * book. The `plan_id = 8` filter alone returns ~100k posts/15d, well
 * past anything we'd want to truck through Q2-Q4 enrichment, so we
 * scope to organization_ids that q10600 already considers active
 * (~560 workspaces today). Without this scope we'd previously have
 * to LIMIT 2000 to keep query times sane, but then ClickHouse picked
 * an arbitrary 2000 rows without an ORDER BY and customer-book posts
 * fell off the cliff — a Branded Hospitality Media weekend send with
 * a 63% delivery rate vanished that way.
 *
 * Org-scoped row counts are bounded (~5–10k for 15d), so we can drop
 * the LIMIT entirely and ORDER BY scheduled_at DESC for stability.
 * Empty orgIds → return empty array; safer than running the unfiltered
 * query and re-introducing the truncation.
 */
async function fetchPosts(
  lookbackDays: number,
  orgIds: string[]
): Promise<Q1Row[]> {
  if (orgIds.length === 0) {
    console.error(
      "[deliverability] fetchPosts called with empty orgIds — skipping Q1 (no customer-book workspaces to filter to)"
    );
    return [];
  }
  const orgInClause = orgIds
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(",");

  // Per-day scoped query. Peak-day enterprise send volume runs
  // ~3,000 posts (see 2026-07-07: 3,011 rows) — right at the edge of
  // any 2000-row cap even with the middleware bypass supposedly on.
  // Historical evidence (Branded Hospitality Media's 2026-07-04
  // "Skin in the Game" send at 79% delivery invisible in the
  // dashboard for a week) shows the middleware flag alone doesn't
  // reliably bypass the truncation. Firing one query per calendar
  // day inside the lookback window guarantees each response is
  // below the cap, and the concatenation covers the full window.
  //
  // Same architectural pattern the publications-index endpoint
  // already uses successfully at similar volume.
  const buildDayQuery = (dayOffset: number): string => `
    SELECT DISTINCT
      toString(p.id) AS post_id,
      toString(pub.id) AS publication_id,
      pub.name AS newsletter,
      toString(o.id) AS organization_id,
      o.name AS workspace_name,
      toString(toDate(p.scheduled_at)) AS sent_date,
      coalesce(
        CASE WHEN char_length(p.email_subject_line) > 80
             THEN left(p.email_subject_line, 77) || '...'
             ELSE p.email_subject_line END,
        CASE WHEN char_length(p.web_title) > 80
             THEN left(p.web_title, 77) || '...'
             ELSE p.web_title END
      ) AS subject
    FROM swarm_clickpipes.organizations o
    JOIN swarm_clickpipes.publications pub ON o.id = pub.organization_id
    JOIN swarm_clickpipes.posts p ON pub.id = p.publication_id
    WHERE o.id IN (${orgInClause})
      AND o.plan_id = 8
      AND p.send_status = 2
      AND toDate(p.scheduled_at) = toDate(now()) - ${dayOffset}
      AND p.scheduled_at < toDate(now())
    ORDER BY p.scheduled_at DESC
  `;

  const out: Q1Row[] = [];
  for (let dayOffset = 1; dayOffset <= lookbackDays; dayOffset++) {
    try {
      const rows = (await runNativeQuery(
        DB.CLICKHOUSE_ADHOC,
        buildDayQuery(dayOffset)
      )) as unknown as Q1Row[];
      if (rows.length >= 2000) {
        // We've hit exactly the historical truncation ceiling — flag
        // it loudly so a future spike day (>2000 sends) doesn't fail
        // silently the way the 15-day-window version used to.
        console.warn(
          `[deliverability] fetchPosts day -${dayOffset} returned ${rows.length} rows — at/above 2000 cap; may need further per-day chunking (by post_id) if this reproduces.`
        );
      }
      for (const r of rows) out.push(r);
    } catch (e) {
      // Per-day isolation — a single failed day shouldn't blackhole
      // the whole 15-day window. Log and continue.
      console.error(
        `[deliverability] fetchPosts day -${dayOffset} failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return out;
}

function toInClause(ids: string[]): string {
  // post IDs are BIGINT in posts, but fact_sendables.sendable_id is String.
  // Quote them to match the String column (safer than unquoted numerics).
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

/**
 * ClickHouse + Metabase choke on very large IN(...) clauses — a 2000-id
 * spam query consistently 60s-timed-out during the snapshot sync. Chunk
 * the IDs into batches and concatenate the results, then de-dupe by id
 * in the caller's join step (existing joinRows logic handles dupes via
 * a Map keyed by id).
 */
const POST_ID_CHUNK_SIZE = 200;

async function runChunked<T>(
  ids: string[],
  buildSql: (chunk: string[]) => string
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += POST_ID_CHUNK_SIZE) {
    const slice = ids.slice(i, i + POST_ID_CHUNK_SIZE);
    const rows = (await runNativeQuery(
      DB.CLICKHOUSE_ADHOC,
      buildSql(slice)
    )) as unknown as T[];
    for (const r of rows) out.push(r);
  }
  return out;
}

async function fetchMetrics(postIds: string[]): Promise<Q2Row[]> {
  return runChunked<Q2Row>(postIds, (chunk) => {
    const inClause = toInClause(chunk);
    return `
      SELECT
        sendable_id,
        sum(unique_subscriber_sent) AS unique_subscriber_sent,
        sum(unique_subscriber_delivered) AS unique_subscriber_delivered,
        sum(unique_subscriber_opened) AS unique_subscriber_opened,
        sum(unique_subscriber_clicked) AS unique_subscriber_clicked,
        sum(unique_subscriber_hard_bounced) AS unique_subscriber_hard_bounced,
        sum(unique_subscriber_soft_bounced) AS unique_subscriber_soft_bounced
      FROM default.fact_sendables_by_type_v1
      WHERE sendable_type = 'Post'
        AND message_type = 'campaign'
        AND sendable_id IN (${inClause})
      GROUP BY sendable_id
    `;
  });
}

async function fetchUnsubs(postIds: string[]): Promise<Q3Row[]> {
  return runChunked<Q3Row>(postIds, (chunk) => {
    const inClause = toInClause(chunk);
    // Schema migration (May 2026): state_events_unsubscribe_post_id moved to
    // swarm_clickpipes and `subscription_id` was renamed to `trackable_id`.
    return `
      SELECT
        toString(unsubscribe_post_id) AS unsubscribe_post_id,
        countDistinct(trackable_id) AS unsubs
      FROM swarm_clickpipes.state_events_unsubscribe_post_id
      WHERE unsubscribe_post_id IN (${inClause})
      GROUP BY unsubscribe_post_id
    `;
  });
}

async function fetchSpam(
  postIds: string[],
  publicationIds: string[]
): Promise<Q4Row[]> {
  // sendgrid_v1 is huge — billions of rows. Two index conditions are
  // mandatory for the query to complete in seconds rather than
  // minute(s):
  //
  //   1. `timestamp` filter → partition prune. The table is
  //      partitioned by toYYYYMM(timestamp); without this filter
  //      every partition gets scanned. 21 days is slightly larger
  //      than LOOKBACK_DAYS to absorb timezone + lag without dropping
  //      legitimate spam events.
  //   2. `publication_id` filter → sort-key prefix seek. The sorting
  //      key starts with (publication_id, sendable_type, message_type,
  //      sendable_id) — filtering all four lets ClickHouse seek
  //      directly to our rows. Without publication_id it scans every
  //      publication's data in the (now pruned) partitions.
  //
  // Probed timings on a 50-id batch:
  //   no filters:                  60s timeout
  //   timestamp only:              156s
  //   timestamp + publication_id:  1.2s
  if (publicationIds.length === 0) return [];
  const pubInClause = toInClause(publicationIds);
  return runChunked<Q4Row>(postIds, (chunk) => {
    const inClause = toInClause(chunk);
    return `
      SELECT
        toString(sendable_id) AS sendable_id,
        countDistinct(subscriber_id) AS spam_reports
      FROM default.sendgrid_v1
      WHERE timestamp >= now() - INTERVAL 21 DAY
        AND publication_id IN (${pubInClause})
        AND sendable_type = 'Post'
        AND message_type = 'campaign'
        AND event IN ('spamreport', 'fbl_spam', 'spam')
        AND sendable_id IN (${inClause})
      GROUP BY sendable_id
    `;
  });
}

function joinRows(
  posts: Q1Row[],
  metrics: Q2Row[],
  unsubs: Q3Row[],
  spam: Q4Row[]
): PostMetricsRow[] {
  const metricsById = new Map<string, Q2Row>(
    metrics.map((m) => [String(m.sendable_id), m])
  );
  const unsubsById = new Map<string, number>(
    unsubs.map((u) => [String(u.unsubscribe_post_id), Number(u.unsubs)])
  );
  const spamById = new Map<string, number>(
    spam.map((s) => [String(s.sendable_id), Number(s.spam_reports)])
  );

  return posts.map((p) => {
    const m = metricsById.get(p.post_id);
    const sent = Number(m?.unique_subscriber_sent ?? 0);
    const delivered = Number(m?.unique_subscriber_delivered ?? 0);
    const opens = Number(m?.unique_subscriber_opened ?? 0);
    const clicks = Number(m?.unique_subscriber_clicked ?? 0);
    const hard = Number(m?.unique_subscriber_hard_bounced ?? 0);
    const soft = Number(m?.unique_subscriber_soft_bounced ?? 0);
    const unsub = unsubsById.get(p.post_id) ?? 0;
    const spamN = spamById.get(p.post_id) ?? 0;

    const safe = (num: number, denom: number) => (denom > 0 ? num / denom : 0);

    return {
      ...p,
      sent,
      delivered,
      delivery_rate: safe(delivered, sent),
      opens,
      open_rate: safe(opens, delivered),
      clicks,
      ctr: safe(clicks, delivered),
      hard_bounces: hard,
      hard_bounce_rate: safe(hard, sent),
      soft_bounces: soft,
      soft_bounce_rate: safe(soft, sent),
      unsubs: unsub,
      unsub_rate: safe(unsub, delivered),
      spam_reports: spamN,
      spam_rate: safe(spamN, delivered),
    };
  });
}

/**
 * Map org_id → customer_success_manager for the running book.
 * Uses Metabase question 10600 (book of business) — this is the same source
 * as the /accounts view so CSM assignment stays in sync everywhere.
 */
async function fetchCsmOwnership(): Promise<Map<string, string>> {
  const rows = await loadCustomers();
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.workspace_id && row.customer_success_manager) {
      map.set(String(row.workspace_id), String(row.customer_success_manager));
    }
  }
  return map;
}

/**
 * Default count of most-recent dates we pre-compute spam for at sync
 * time. The dashboard's default view is "yesterday", so a 3-day
 * window covers Mon-after-Fri-sync edge cases without forcing the
 * full 15-day spam scan that consistently 60s-time-out'd.
 */
const SPAM_PRECOMPUTE_RECENT_DAYS = 3;

/**
 * Pre-compute the joined post-metrics rows for the entire lookback
 * window. Used by scripts/sync.ts to write data/deliverability.enc.json
 * — the dashboard then reads from disk and applies thresholds +
 * filters at request time, so threshold tweaks take effect without
 * a resync.
 *
 * Spam handling: a 15-day-wide Q4 against sendgrid_v1 consistently
 * 60s-time-out'd in early experiments (the table is too large to
 * scan without a date filter that we can't safely add without
 * confirming the column schema). Instead we pre-compute spam **per
 * date** for the most-recent N dates only — each per-date query is
 * a 50–200-id IN clause that runs in seconds. The returned snapshot
 * carries:
 *   • `posts` with spam_reports/spam_rate baked in for those dates
 *   • `spam_dates` listing which dates have authoritative spam data
 * The runtime engine reads `spam_dates` and skips its overlay path
 * entirely when the target date is covered.
 */
export async function fetchDeliverabilityPosts(
  lookbackDays: number = LOOKBACK_DAYS,
  spamRecentDays: number = SPAM_PRECOMPUTE_RECENT_DAYS
): Promise<{ posts: PostMetricsRow[]; spam_dates: string[] }> {
  // Source of truth for "which orgs do we surface" — q10600 (the CSM
  // book of business). Filtering Q1 here aligns the deliverability
  // snapshot with whatever the rest of the dashboard considers an
  // active customer, and keeps Q1's row count bounded so we don't
  // need an arbitrary LIMIT to keep sync times sane.
  //
  // UUID filter is required: loadCustomers() appends a synthetic
  // TEST_CUSTOMER row whose workspace_id is the literal string
  // "test-workspace" (not a UUID). The `o.id` column in ClickHouse
  // is typed UUID and the database refuses the whole IN clause when
  // any value can't parse, so a single bad ID kills the entire Q1
  // query and the snapshot ships empty.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const customers = await loadCustomers();
  const allWorkspaceIds = customers
    .map((c) => c.workspace_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const orgIds = Array.from(
    new Set(allWorkspaceIds.filter((id) => UUID_RE.test(id)))
  );
  const dropped = allWorkspaceIds.length - orgIds.length;
  console.error(
    `[deliverability] scoping Q1 to ${orgIds.length} customer-book workspaces${
      dropped > 0 ? ` (dropped ${dropped} non-UUID workspace_ids)` : ""
    }`
  );
  const posts = await fetchPosts(lookbackDays, orgIds);
  const postIds = posts.map((p) => p.post_id);

  const safe = async <T>(p: Promise<T[]>, label: string): Promise<T[]> => {
    try {
      return await p;
    } catch (e) {
      console.error(
        `[deliverability] ${label} failed:`,
        e instanceof Error ? e.message : e
      );
      return [];
    }
  };

  const [metrics, unsubs] = await Promise.all([
    safe(fetchMetrics(postIds), "metrics"),
    safe(fetchUnsubs(postIds), "unsubs"),
  ]);

  // Initial join leaves spam_reports = 0 everywhere; we'll patch in
  // fresh values per-date for the recent window below.
  const joined = joinRows(posts, metrics, unsubs, []);

  // Group post IDs by date so we can fire one spam query per date.
  // Sorted descending so the most recent date is queried first —
  // that's the one the dashboard renders by default, and the order
  // matters if a later date times out and we abort the rest.
  const idsByDate = new Map<string, string[]>();
  for (const p of joined) {
    const arr = idsByDate.get(p.sent_date) ?? [];
    arr.push(p.post_id);
    idsByDate.set(p.sent_date, arr);
  }
  const recentDates = [...idsByDate.keys()]
    .sort()
    .reverse()
    .slice(0, spamRecentDays);

  const spamDates: string[] = [];
  for (const date of recentDates) {
    const ids = idsByDate.get(date) ?? [];
    if (ids.length === 0) continue;
    // Publications that sent on this date — needed for the
    // sort-prefix seek in fetchSpam (see comment there).
    const pubIds = [
      ...new Set(
        joined.filter((p) => p.sent_date === date).map((p) => p.publication_id)
      ),
    ];
    try {
      const dateSpam = await fetchSpam(ids, pubIds);
      const byId = new Map(
        dateSpam.map((s) => [String(s.sendable_id), Number(s.spam_reports)])
      );
      // Patch spam_reports/spam_rate on the joined rows for this date.
      for (const p of joined) {
        if (p.sent_date !== date) continue;
        const reports = byId.get(p.post_id) ?? 0;
        p.spam_reports = reports;
        p.spam_rate = p.delivered > 0 ? reports / p.delivered : 0;
      }
      spamDates.push(date);
    } catch (e) {
      // Per-date isolation: a fail on date X doesn't stop us from
      // trying date Y. The runtime overlay path covers any dates we
      // couldn't pre-compute.
      console.error(
        `[deliverability] pre-compute spam for ${date} failed (runtime overlay will retry):`,
        e instanceof Error ? e.message : e
      );
    }
  }

  return { posts: joined, spam_dates: spamDates };
}

export interface DeliverabilityRunOptions {
  /** Limit to one CSM's book (uses CSM_NAME env by default). Pass null for all. */
  csmName?: string | null;
  /** How far back to fetch posts. Default 15 to stay safely under 2000-row cap. */
  lookbackDays?: number;
  /** Filter to a specific sent date (YYYY-MM-DD) — defaults to yesterday UTC. */
  targetDate?: string;
}

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface DeliverabilityRunResult {
  target_date: string;
  csm_name: string | null;
  total_posts_yesterday: number;
  total_enterprise_posts: number;
  alerts: DeliverabilityAlert[];
  /** When this engine run was computed (current request time). */
  generated_at: string;
  /** When the underlying snapshot was last written by sync.ts. Null
   *  when running off a live fetch (local dev pre-sync). Powers the
   *  freshness indicator in the panel header so a stale snapshot
   *  isn't silently misleading — see the daily 08/16 UTC cron in
   *  .github/workflows/sync-data.yml. */
  snapshot_generated_at: string | null;
}

// In-process cache so repeat hits within the same isolate are
// instant. Keyed by lookback only (CSM + target date are applied
// client-side over the cached joined posts).
interface CacheEntry {
  expires: number;
  pending: Promise<{
    joinedPosts: PostMetricsRow[];
    csmByOrg: Map<string, string>;
    /** Dates whose spam_reports column is authoritative in the
     *  snapshot. The engine uses this to decide whether to skip
     *  the runtime overlay for a given target date. */
    spamDates: Set<string>;
    /** Snapshot mtime as recorded by sync.ts. Null when the engine
     *  falls back to a live fetch (no snapshot on disk). */
    snapshotGeneratedAt: string | null;
  }>;
}
const runCache = new Map<string, CacheEntry>();
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Per-target-date spam cache. Q4 against sendgrid_v1 is the slow
 * outlier on the deliverability render path — even chunked it can
 * take 10–60s depending on warehouse load. Without this cache every
 * page load re-fires the query; with it, every load after the first
 * within a 10-min window hits in memory.
 */
const spamCache = new Map<
  string,
  { expires: number; pending: Promise<Q4Row[]> }
>();

/** Hard cap on how long we'll wait for the spam overlay before
 *  rendering the page without it. The dashboard is more useful
 *  without spam columns than it is locked behind a stuck query. */
const SPAM_TIMEOUT_MS = 4000;

/** Promise wrapper that resolves to `fallback` if `promise` doesn't
 *  settle within `ms`. The underlying request keeps running (no
 *  AbortSignal plumbed through Metabase yet) — we just stop waiting
 *  for it on the request thread. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.error(
        `[deliverability] ${label} timed out after ${ms}ms — rendering without it`
      );
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        console.error(
          `[deliverability] ${label} errored:`,
          err instanceof Error ? err.message : err
        );
        resolve(fallback);
      }
    );
  });
}

/**
 * Fetch spam reports for one target date with caching + timeout. The
 * first hit per (date, isolate) within the cache window fires the
 * ClickHouse query (time-bounded); every later hit returns the same
 * promise.
 */
function spamForDate(
  postIds: string[],
  publicationIds: string[],
  targetDate: string
): Promise<Q4Row[]> {
  if (postIds.length === 0) return Promise.resolve([]);
  const now = Date.now();
  const cached = spamCache.get(targetDate);
  if (cached && cached.expires > now) return cached.pending;
  const pending = withTimeout(
    fetchSpam(postIds, publicationIds),
    SPAM_TIMEOUT_MS,
    [],
    `spam for ${targetDate}`
  );
  spamCache.set(targetDate, { expires: now + RUN_CACHE_TTL_MS, pending });
  return pending;
}

/**
 * Get the joined post-metrics rows for the lookback window plus the
 * set of dates for which spam was pre-computed at sync time. Tries
 * the snapshot file written by sync.ts first; falls back to a live
 * fetch only if the file is missing (local dev before `npm run sync`
 * has been run).
 */
async function getJoinedPosts(
  lookback: number
): Promise<{
  posts: PostMetricsRow[];
  spamDates: Set<string>;
  snapshotGeneratedAt: string | null;
}> {
  const snap = await readDeliverabilitySnapshot();
  if (snap && Array.isArray(snap.posts)) {
    return {
      posts: snap.posts,
      // spam_dates was added with the "pre-compute spam at sync"
      // change. Treat missing as "no pre-computed coverage" so the
      // runtime overlay kicks in everywhere — safe default.
      spamDates: new Set(snap.spam_dates ?? []),
      snapshotGeneratedAt: snap.generated_at ?? null,
    };
  }
  // No snapshot — fall back to a live fetch. Slow path, but keeps
  // local dev working before `npm run sync` has been run.
  const result = await fetchDeliverabilityPosts(lookback);
  return {
    posts: result.posts,
    spamDates: new Set(result.spam_dates),
    snapshotGeneratedAt: null,
  };
}

export async function runDeliverabilityCheck(
  opts: DeliverabilityRunOptions = {}
): Promise<DeliverabilityRunResult> {
  const csmName =
    opts.csmName === undefined ? process.env.CSM_NAME ?? null : opts.csmName;
  const lookback = opts.lookbackDays ?? LOOKBACK_DAYS;
  const targetDate = opts.targetDate ?? yesterdayUtc();

  const cacheKey = `${lookback}`;
  const now = Date.now();
  let entry = runCache.get(cacheKey);
  if (!entry || entry.expires < now) {
    entry = {
      expires: now + RUN_CACHE_TTL_MS,
      pending: (async () => {
        const [snap, csmByOrg] = await Promise.all([
          getJoinedPosts(lookback),
          fetchCsmOwnership(),
        ]);
        return {
          joinedPosts: snap.posts,
          csmByOrg,
          spamDates: snap.spamDates,
          snapshotGeneratedAt: snap.snapshotGeneratedAt,
        };
      })(),
    };
    runCache.set(cacheKey, entry);
  }

  const { joinedPosts, csmByOrg, spamDates, snapshotGeneratedAt } =
    await entry.pending;

  let targetPosts = joinedPosts.filter((p) => p.sent_date === targetDate);

  // Spam coverage decision: if the sync already pre-computed spam for
  // this date, the joined-rows are authoritative — skip the runtime
  // overlay entirely (no ClickHouse on the hot path). Only fall back
  // to the live overlay when the target date is OUTSIDE the
  // pre-computed window — a rare edge case (user picked a date >3d
  // back) where we'd rather pay the wait than show zero spam.
  if (!spamDates.has(targetDate) && targetPosts.length > 0) {
    const pubIds = [...new Set(targetPosts.map((p) => p.publication_id))];
    const spam = await spamForDate(
      targetPosts.map((p) => p.post_id),
      pubIds,
      targetDate
    );
    if (spam.length > 0) {
      const spamById = new Map(
        spam.map((s) => [String(s.sendable_id), Number(s.spam_reports)])
      );
      targetPosts = targetPosts.map((p) => {
        const reports = spamById.get(p.post_id);
        if (!reports) return p;
        const denom = p.delivered > 0 ? p.delivered : 0;
        return {
          ...p,
          spam_reports: reports,
          spam_rate: denom > 0 ? reports / denom : 0,
        };
      });
    }
  }

  // Thresholds applied at request time (not at sync time) so
  // /settings/general edits take effect without a resync.
  //
  // We surface EVERY relevant post (per CSM filter) regardless of
  // whether it tripped a flag — readers want the full publication
  // sweep, not just the alarms. Clean posts ship through with an
  // empty `flags` array; the panel renders a "Clean" pill for them.
  // Cleared resolutions are attached so the panel can hide acknowledged
  // sends behind a "Show cleared" toggle.
  const clearedByPost = await loadClearedPosts();
  const alerts: DeliverabilityAlert[] = [];
  const seenPostIds = new Set<string>();
  for (const post of targetPosts) {
    const ownerCsm = csmByOrg.get(post.organization_id) ?? null;
    if (csmName && ownerCsm !== csmName) continue;
    const flags = analyzePost(post);
    const cleared = clearedByPost[post.post_id] ?? null;
    alerts.push({ post, flags, csm: ownerCsm, cleared });
    seenPostIds.add(post.post_id);
  }

  // Carryover pass: scan the rest of the lookback window for any
  // FLAGGED post (critical OR warning) that the CSM hasn't cleared
  // yet, and surface it alongside the target-date alerts. Anything
  // that tripped a threshold sticks around until a CSM explicitly
  // clears it — that includes warning-band sends (e.g. delivery
  // between 0.95 and 0.97) which used to silently drop off because
  // the gate was critical-only. The user-reported "low delivery
  // rate but not flagged here" Hospitality Headline incident traced
  // back to exactly that gap.
  //
  // Clean sends (no flags) still DO NOT carry over — they refresh
  // with the target date. Cleared flagged sends also drop out of the
  // active list (still visible behind "Show cleared").
  for (const post of joinedPosts) {
    if (post.sent_date === targetDate) continue; // already handled
    if (seenPostIds.has(post.post_id)) continue; // dedupe defensive
    const ownerCsm = csmByOrg.get(post.organization_id) ?? null;
    if (csmName && ownerCsm !== csmName) continue;
    const cleared = clearedByPost[post.post_id] ?? null;
    if (cleared) continue; // cleared sends don't follow forward
    const flags = analyzePost(post);
    if (flags.length === 0) continue; // clean send — refreshes with target_date
    alerts.push({ post, flags, csm: ownerCsm, cleared: null });
    seenPostIds.add(post.post_id);
  }

  // Sort: critical count desc, then warning count desc, then sent desc
  alerts.sort((a, b) => {
    const ac = a.flags.filter((f) => f.severity === "critical").length;
    const bc = b.flags.filter((f) => f.severity === "critical").length;
    if (ac !== bc) return bc - ac;
    if (a.flags.length !== b.flags.length) return b.flags.length - a.flags.length;
    return b.post.sent - a.post.sent;
  });

  return {
    target_date: targetDate,
    csm_name: csmName,
    total_posts_yesterday: targetPosts.length,
    total_enterprise_posts: joinedPosts.length,
    alerts,
    generated_at: new Date().toISOString(),
    snapshot_generated_at: snapshotGeneratedAt,
  };
}
