import { DB, runNativeQuery } from "../metabase";
import type { Customer } from "../types";

/**
 * Wins metrics fetcher — per-post + per-publication rollups over a
 * 120-day window for the CSM book. Reuses the same ClickHouse tables
 * as the deliverability engine (fact_sendables_by_type_v1) so the
 * metrics are directly comparable across surfaces.
 *
 * Phase 1 ships against RAW open/click metrics. The engine wrapper
 * carries a `metrics_source: "raw" | "verified"` config field that
 * the UI notes; once a Metabase question exposes MPP-filtered
 * verified opens + clicks, we swap the sendable columns below in a
 * single commit.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POST_ID_CHUNK_SIZE = 200;

/** Default lookback — 120 days covers a 3-week streak evaluated
 *  against a trailing 12-week baseline (≈15 weeks of data) plus a
 *  MoM growth-check period, comfortably. */
export const DEFAULT_LOOKBACK_DAYS = 120;

export interface PostMetric {
  post_id: string;
  publication_id: string;
  organization_id: string;
  publication_name: string;
  workspace_name: string;
  /** YYYY-MM-DD, UTC. */
  sent_date: string;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  hard_bounces: number;
  soft_bounces: number;
  delivery_rate: number;
  open_rate: number;
  /** click-through-open rate (clicks / opens). Null when opens = 0
   *  so a zero-open send doesn't look like a 0% ctor record. */
  ctor: number | null;
}

/** ISO-week bucket for streak-style rules. `week_start` is the
 *  Monday of the ISO week (UTC), sends is the total sent volume for
 *  the week, open_rate/ctor are weighted-average rates across the
 *  posts sent that week. */
export interface WeeklyBucket {
  week_start: string;
  posts: number;
  sends: number;
  delivered: number;
  opens: number;
  clicks: number;
  hard_bounces: number;
  soft_bounces: number;
  open_rate: number;
  ctor: number | null;
  delivery_rate: number;
}

export interface PublicationMetrics {
  publication_id: string;
  publication_name: string;
  organization_id: string;
  workspace_name: string;
  posts: PostMetric[];
  weeklyBuckets: WeeklyBucket[];
}

export interface WinsMetricsSnapshot {
  /** Keyed by workspace_id (uuid), each entry contains every
   *  publication rollup we could gather for that workspace. */
  byWorkspace: Map<string, PublicationMetrics[]>;
  fetched_at: string;
  lookback_days: number;
  metrics_source: "raw" | "verified";
}

interface Q1Row {
  post_id: string;
  publication_id: string;
  publication_name: string;
  organization_id: string;
  workspace_name: string;
  sent_date: string;
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

function toInClause(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

async function fetchPosts(
  lookbackDays: number,
  orgIds: string[]
): Promise<Q1Row[]> {
  if (orgIds.length === 0) return [];
  const orgInClause = toInClause(orgIds);
  const sql = `
    SELECT
      toString(p.id) AS post_id,
      toString(pub.id) AS publication_id,
      pub.name AS publication_name,
      toString(o.id) AS organization_id,
      o.name AS workspace_name,
      toString(toDate(p.scheduled_at)) AS sent_date
    FROM swarm_clickpipes.organizations o
    JOIN swarm_clickpipes.publications pub ON o.id = pub.organization_id
    JOIN swarm_clickpipes.posts p ON pub.id = p.publication_id
    WHERE o.id IN (${orgInClause})
      AND p.send_status = 2
      AND p.scheduled_at >= now() - INTERVAL ${lookbackDays} DAY
      AND p.scheduled_at < toDate(now())
    ORDER BY p.scheduled_at DESC
  `;
  const rows = (await runNativeQuery(
    DB.CLICKHOUSE_ADHOC,
    sql
  )) as unknown as Q1Row[];
  return rows;
}

async function fetchMetrics(postIds: string[]): Promise<Q2Row[]> {
  if (postIds.length === 0) return [];
  const out: Q2Row[] = [];
  for (let i = 0; i < postIds.length; i += POST_ID_CHUNK_SIZE) {
    const slice = postIds.slice(i, i + POST_ID_CHUNK_SIZE);
    const inClause = toInClause(slice);
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
    const rows = (await runNativeQuery(
      DB.CLICKHOUSE_ADHOC,
      sql
    )) as unknown as Q2Row[];
    for (const r of rows) out.push(r);
  }
  return out;
}

function isoWeekStart(dateYmd: string): string {
  const d = new Date(`${dateYmd}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function safeRate(num: number, denom: number): number {
  return denom > 0 ? num / denom : 0;
}

function ctorOrNull(clicks: number, opens: number): number | null {
  return opens > 0 ? clicks / opens : null;
}

/**
 * Fetch the raw post + metrics data and roll it up per publication.
 * Callers pass in the pre-loaded customer list; the fetcher scopes
 * ClickHouse queries to that book's workspace_ids so a wins run
 * doesn't scan the whole platform.
 */
export async function fetchWinsMetrics(opts: {
  customers: Customer[];
  lookbackDays?: number;
  metricsSource?: "raw" | "verified";
}): Promise<WinsMetricsSnapshot> {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const metricsSource = opts.metricsSource ?? "raw";

  const workspaceIds = Array.from(
    new Set(
      opts.customers
        .map((c) => c.workspace_id)
        .filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
    )
  );

  const byWorkspace = new Map<string, PublicationMetrics[]>();
  if (workspaceIds.length === 0) {
    return {
      byWorkspace,
      fetched_at: new Date().toISOString(),
      lookback_days: lookbackDays,
      metrics_source: metricsSource,
    };
  }

  const posts = await fetchPosts(lookbackDays, workspaceIds);
  if (posts.length === 0) {
    return {
      byWorkspace,
      fetched_at: new Date().toISOString(),
      lookback_days: lookbackDays,
      metrics_source: metricsSource,
    };
  }
  const metrics = await fetchMetrics(posts.map((p) => p.post_id));
  const metricsById = new Map<string, Q2Row>(
    metrics.map((m) => [String(m.sendable_id), m])
  );

  // Join Q1 + Q2 into PostMetric rows.
  const joinedPosts: PostMetric[] = posts.map((p) => {
    const m = metricsById.get(p.post_id);
    const sent = Number(m?.unique_subscriber_sent ?? 0);
    const delivered = Number(m?.unique_subscriber_delivered ?? 0);
    const opens = Number(m?.unique_subscriber_opened ?? 0);
    const clicks = Number(m?.unique_subscriber_clicked ?? 0);
    const hard = Number(m?.unique_subscriber_hard_bounced ?? 0);
    const soft = Number(m?.unique_subscriber_soft_bounced ?? 0);
    return {
      post_id: p.post_id,
      publication_id: p.publication_id,
      organization_id: p.organization_id,
      publication_name: p.publication_name,
      workspace_name: p.workspace_name,
      sent_date: p.sent_date,
      sent,
      delivered,
      opens,
      clicks,
      hard_bounces: hard,
      soft_bounces: soft,
      delivery_rate: safeRate(delivered, sent),
      open_rate: safeRate(opens, delivered),
      ctor: ctorOrNull(clicks, opens),
    };
  });

  // Group by publication, then compute per-week buckets.
  const byPub = new Map<string, PostMetric[]>();
  for (const post of joinedPosts) {
    const arr = byPub.get(post.publication_id) ?? [];
    arr.push(post);
    byPub.set(post.publication_id, arr);
  }

  for (const [publicationId, pubPosts] of byPub.entries()) {
    const first = pubPosts[0];
    const buckets = new Map<string, WeeklyBucket>();
    for (const post of pubPosts) {
      const weekStart = isoWeekStart(post.sent_date);
      const b =
        buckets.get(weekStart) ??
        ({
          week_start: weekStart,
          posts: 0,
          sends: 0,
          delivered: 0,
          opens: 0,
          clicks: 0,
          hard_bounces: 0,
          soft_bounces: 0,
          open_rate: 0,
          ctor: null,
          delivery_rate: 0,
        } as WeeklyBucket);
      b.posts += 1;
      b.sends += post.sent;
      b.delivered += post.delivered;
      b.opens += post.opens;
      b.clicks += post.clicks;
      b.hard_bounces += post.hard_bounces;
      b.soft_bounces += post.soft_bounces;
      buckets.set(weekStart, b);
    }
    const weeklyBuckets = Array.from(buckets.values())
      .map((b) => ({
        ...b,
        open_rate: safeRate(b.opens, b.delivered),
        ctor: ctorOrNull(b.clicks, b.opens),
        delivery_rate: safeRate(b.delivered, b.sends),
      }))
      .sort((a, b) => a.week_start.localeCompare(b.week_start));

    const rollup: PublicationMetrics = {
      publication_id: publicationId,
      publication_name: first.publication_name,
      organization_id: first.organization_id,
      workspace_name: first.workspace_name,
      posts: pubPosts.slice().sort((a, b) => a.sent_date.localeCompare(b.sent_date)),
      weeklyBuckets,
    };
    const arr = byWorkspace.get(first.organization_id) ?? [];
    arr.push(rollup);
    byWorkspace.set(first.organization_id, arr);
  }

  return {
    byWorkspace,
    fetched_at: new Date().toISOString(),
    lookback_days: lookbackDays,
    metrics_source: metricsSource,
  };
}
