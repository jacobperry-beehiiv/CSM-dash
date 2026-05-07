import { DB, runNativeQuery } from "../metabase";
import { loadCustomers } from "../data/load-customers";
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

async function fetchPosts(lookbackDays: number): Promise<Q1Row[]> {
  const sql = `
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
    WHERE o.plan_id = 8
      AND p.send_status = 2
      AND p.scheduled_at >= now() - INTERVAL ${lookbackDays} DAY
      AND p.scheduled_at < toDate(now())
    LIMIT 2000
  `;
  const rows = (await runNativeQuery(DB.CLICKHOUSE_ADHOC, sql)) as unknown as Q1Row[];
  return rows;
}

function toInClause(ids: string[]): string {
  // post IDs are BIGINT in posts, but fact_sendables.sendable_id is String.
  // Quote them to match the String column (safer than unquoted numerics).
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

async function fetchMetrics(postIds: string[]): Promise<Q2Row[]> {
  if (postIds.length === 0) return [];
  const inClause = toInClause(postIds);
  const sql = `
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
  return (await runNativeQuery(DB.CLICKHOUSE_ADHOC, sql)) as unknown as Q2Row[];
}

async function fetchUnsubs(postIds: string[]): Promise<Q3Row[]> {
  if (postIds.length === 0) return [];
  const inClause = toInClause(postIds);
  // Schema migration (May 2026): state_events_unsubscribe_post_id moved to
  // swarm_clickpipes and `subscription_id` was renamed to `trackable_id`.
  const sql = `
    SELECT
      toString(unsubscribe_post_id) AS unsubscribe_post_id,
      countDistinct(trackable_id) AS unsubs
    FROM swarm_clickpipes.state_events_unsubscribe_post_id
    WHERE unsubscribe_post_id IN (${inClause})
    GROUP BY unsubscribe_post_id
  `;
  return (await runNativeQuery(DB.CLICKHOUSE_ADHOC, sql)) as unknown as Q3Row[];
}

async function fetchSpam(postIds: string[]): Promise<Q4Row[]> {
  if (postIds.length === 0) return [];
  const inClause = toInClause(postIds);
  const sql = `
    SELECT
      toString(sendable_id) AS sendable_id,
      countDistinct(subscriber_id) AS spam_reports
    FROM default.sendgrid_v1
    WHERE sendable_type = 'Post'
      AND message_type = 'campaign'
      AND event IN ('spamreport', 'fbl_spam', 'spam')
      AND sendable_id IN (${inClause})
    GROUP BY sendable_id
  `;
  return (await runNativeQuery(DB.CLICKHOUSE_ADHOC, sql)) as unknown as Q4Row[];
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
  generated_at: string;
}

// In-process cache so once-per-process runs serve subsequent UI loads
// instantly. ClickHouse roundtrips can be 30–60s; the underlying data only
// changes once a day so a 10-min TTL is plenty. Keyed by lookback+date so
// the same key serves all CSM filters off one fetch.
interface CacheEntry {
  expires: number;
  pending: Promise<{
    allPosts: Q1Row[];
    metrics: Q2Row[];
    unsubs: Q3Row[];
    spam: Q4Row[];
    csmByOrg: Map<string, string>;
    targetDate: string;
  }>;
}
const runCache = new Map<string, CacheEntry>();
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;

export async function runDeliverabilityCheck(
  opts: DeliverabilityRunOptions = {}
): Promise<DeliverabilityRunResult> {
  const csmName =
    opts.csmName === undefined ? process.env.CSM_NAME ?? null : opts.csmName;
  const lookback = opts.lookbackDays ?? LOOKBACK_DAYS;
  const targetDate = opts.targetDate ?? yesterdayUtc();

  const cacheKey = `${lookback}|${targetDate}`;
  const now = Date.now();
  let entry = runCache.get(cacheKey);
  if (!entry || entry.expires < now) {
    entry = {
      expires: now + RUN_CACHE_TTL_MS,
      pending: (async () => {
        const [allPosts, csmByOrg] = await Promise.all([
          fetchPosts(lookback),
          fetchCsmOwnership(),
        ]);
        const targetPosts = allPosts.filter((p) => p.sent_date === targetDate);
        const targetIds = targetPosts.map((p) => p.post_id);
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
        const [metrics, unsubs, spam] = await Promise.all([
          safe(fetchMetrics(targetIds), "metrics"),
          safe(fetchUnsubs(targetIds), "unsubs"),
          safe(fetchSpam(targetIds), "spam"),
        ]);
        return { allPosts, metrics, unsubs, spam, csmByOrg, targetDate };
      })(),
    };
    runCache.set(cacheKey, entry);
  }

  const { allPosts, metrics, unsubs, spam, csmByOrg } = await entry.pending;

  const targetPosts = allPosts.filter((p) => p.sent_date === targetDate);

  const joined = joinRows(targetPosts, metrics, unsubs, spam);

  const alerts: DeliverabilityAlert[] = [];
  for (const post of joined) {
    const flags = analyzePost(post);
    if (flags.length === 0) continue;
    const ownerCsm = csmByOrg.get(post.organization_id) ?? null;
    if (csmName && ownerCsm !== csmName) continue;
    alerts.push({ post, flags, csm: ownerCsm });
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
    total_enterprise_posts: allPosts.length,
    alerts,
    generated_at: new Date().toISOString(),
  };
}
