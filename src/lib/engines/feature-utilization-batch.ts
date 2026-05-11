import { DB, runNativeQuery } from "../metabase";

/**
 * Batched Enterprise Feature Utilization
 * ---------------------------------------
 * Runs the same set of feature signals as `runFeatureUtilization()`, but for
 * an arbitrary list of organization_ids in a single Postgres trip. Used by
 * the book-level Feature Utilization filter so we don't fan out one query
 * per customer (which would be slow + flaky against q-cache).
 *
 * Each CTE groups by organization_id; the final SELECT left-joins them so
 * orgs with zero usage of a feature still get a row (with `false` flags).
 */

export interface FeatureBatchRow {
  organization_id: string;
  mcp: boolean;
  podcasts: boolean;
  ad_network: boolean;
  direct_sponsorships: boolean;
  automations: boolean;
  segments: boolean;
  boost_monetize: boolean;
  boost_grow: boolean;
  referrals: boolean;
  polls: boolean;
  t4: boolean;
}

export type FeatureBatchMap = Record<string, FeatureBatchRow>;

function quoteList(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

function buildSql(orgIds: string[]): string {
  const list = quoteList(orgIds);
  return `
    WITH org_pubs AS (
      SELECT id AS publication_id, organization_id
      FROM public.publications
      WHERE organization_id IN (${list})
        AND deleted_at IS NULL
    ),
    mcp AS (
      SELECT organization_id, COUNT(*) > 0 AS mcp_used
      FROM public.mcp_audit_logs
      WHERE organization_id IN (${list})
      GROUP BY organization_id
    ),
    podcasts AS (
      SELECT op.organization_id, COUNT(pe.id) > 0 AS used
      FROM org_pubs op
      JOIN public.podcast_shows ps
        ON ps.publication_id = op.publication_id
       AND ps.deleted_at IS NULL
      LEFT JOIN public.podcast_episodes pe
        ON pe.podcast_show_id = ps.id
       AND pe.status = 'published'
       AND pe.deleted_at IS NULL
      GROUP BY op.organization_id
    ),
    ad_combined AS (
      SELECT op.organization_id,
        BOOL_OR(
          (opp.provision_type IS NULL OR opp.provision_type <> 'direct')
            AND opp.status NOT IN ('rejected','cancelled')
        ) AS ad_network_used,
        BOOL_OR(opp.provision_type = 'direct') AS direct_used
      FROM org_pubs op
      JOIN public.ad_network_opportunities opp
        ON opp.publication_id = op.publication_id
       AND opp.deleted_at IS NULL
      GROUP BY op.organization_id
    ),
    automations AS (
      SELECT op.organization_id, COUNT(a.id) > 0 AS used
      FROM org_pubs op
      JOIN public.automations a
        ON a.publication_id = op.publication_id
       AND a.deleted_at IS NULL
       AND a.template = FALSE
      GROUP BY op.organization_id
    ),
    segments AS (
      SELECT op.organization_id, COUNT(s.id) > 0 AS used
      FROM org_pubs op
      JOIN public.segments s
        ON s.publication_id = op.publication_id
       AND s.deleted_at IS NULL
      GROUP BY op.organization_id
    ),
    boost_monetize AS (
      SELECT op.organization_id, COUNT(ba.id) > 0 AS used
      FROM org_pubs op
      JOIN public.boost_agreements ba
        ON ba.publication_id = op.publication_id
       AND ba.status = 'accepted'
      GROUP BY op.organization_id
    ),
    boost_grow AS (
      SELECT op.organization_id, COUNT(bo.id) > 0 AS used
      FROM org_pubs op
      JOIN public.boost_offers bo
        ON bo.publication_id = op.publication_id
      GROUP BY op.organization_id
    ),
    referrals AS (
      SELECT op.organization_id, BOOL_OR(rp.created_at IS NOT NULL) AS used
      FROM org_pubs op
      JOIN public.referral_programs rp
        ON rp.publication_id = op.publication_id
       AND rp.deleted_at IS NULL
      GROUP BY op.organization_id
    ),
    polls AS (
      SELECT op.organization_id, COUNT(p.id) > 0 AS used
      FROM org_pubs op
      JOIN public.polls p
        ON p.publication_id = op.publication_id
       AND p.deleted_at IS NULL
      GROUP BY op.organization_id
    ),
    t4 AS (
      SELECT op.organization_id,
        BOOL_OR(rc.onboarding_completed_at IS NOT NULL) AS used
      FROM org_pubs op
      JOIN public.recommendation_configurations rc
        ON rc.publication_id = op.publication_id
      GROUP BY op.organization_id
    ),
    orgs AS (
      SELECT DISTINCT organization_id::uuid AS organization_id
      FROM (VALUES ${list
        .split(",")
        .map((v) => `(${v})`)
        .join(",")}) AS v(organization_id)
    )
    SELECT
      orgs.organization_id AS organization_id,
      COALESCE(mcp.mcp_used, false)             AS mcp,
      COALESCE(podcasts.used, false)            AS podcasts,
      COALESCE(ad_combined.ad_network_used, false) AS ad_network,
      COALESCE(ad_combined.direct_used, false)  AS direct_sponsorships,
      COALESCE(automations.used, false)         AS automations,
      COALESCE(segments.used, false)            AS segments,
      COALESCE(boost_monetize.used, false)      AS boost_monetize,
      COALESCE(boost_grow.used, false)          AS boost_grow,
      COALESCE(referrals.used, false)           AS referrals,
      COALESCE(polls.used, false)               AS polls,
      COALESCE(t4.used, false)                  AS t4
    FROM orgs
    LEFT JOIN mcp            ON mcp.organization_id = orgs.organization_id
    LEFT JOIN podcasts       ON podcasts.organization_id = orgs.organization_id
    LEFT JOIN ad_combined    ON ad_combined.organization_id = orgs.organization_id
    LEFT JOIN automations    ON automations.organization_id = orgs.organization_id
    LEFT JOIN segments       ON segments.organization_id = orgs.organization_id
    LEFT JOIN boost_monetize ON boost_monetize.organization_id = orgs.organization_id
    LEFT JOIN boost_grow     ON boost_grow.organization_id = orgs.organization_id
    LEFT JOIN referrals      ON referrals.organization_id = orgs.organization_id
    LEFT JOIN polls          ON polls.organization_id = orgs.organization_id
    LEFT JOIN t4             ON t4.organization_id = orgs.organization_id
  `;
}

let cache: { ids: string; expires: number; data: FeatureBatchMap } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function runFeatureUtilizationBatch(
  organizationIds: string[]
): Promise<FeatureBatchMap> {
  if (organizationIds.length === 0) return {};

  // Cache by the sorted-id signature so repeated filter-open requests are
  // free as long as the book hasn't changed.
  const sorted = [...new Set(organizationIds)].sort();
  const key = sorted.join("|");
  const now = Date.now();
  if (cache && cache.ids === key && cache.expires > now) {
    return cache.data;
  }

  const sql = buildSql(sorted);
  const rows = (await runNativeQuery(DB.POSTGRES, sql)) as unknown as Array<
    Record<string, unknown>
  >;

  const map: FeatureBatchMap = {};
  for (const r of rows) {
    const id = String(r.organization_id);
    map[id] = {
      organization_id: id,
      mcp: Boolean(r.mcp),
      podcasts: Boolean(r.podcasts),
      ad_network: Boolean(r.ad_network),
      direct_sponsorships: Boolean(r.direct_sponsorships),
      automations: Boolean(r.automations),
      segments: Boolean(r.segments),
      boost_monetize: Boolean(r.boost_monetize),
      boost_grow: Boolean(r.boost_grow),
      referrals: Boolean(r.referrals),
      polls: Boolean(r.polls),
      t4: Boolean(r.t4),
    };
  }

  cache = { ids: key, expires: now + CACHE_TTL_MS, data: map };
  return map;
}

/** The 11 features we expose in the filter — matches the panel order. */
export const FEATURE_BATCH_KEYS = [
  "mcp",
  "podcasts",
  "ad_network",
  "direct_sponsorships",
  "automations",
  "segments",
  "boost_monetize",
  "boost_grow",
  "referrals",
  "polls",
  "t4",
] as const satisfies ReadonlyArray<keyof FeatureBatchRow>;

export type FeatureBatchKey = (typeof FEATURE_BATCH_KEYS)[number];

export const FEATURE_BATCH_LABELS: Record<FeatureBatchKey, string> = {
  mcp: "MCP",
  podcasts: "Podcasts",
  ad_network: "Ad Network",
  direct_sponsorships: "Direct Sponsorships",
  automations: "Automations",
  segments: "Segments",
  boost_monetize: "Boost — Monetize",
  boost_grow: "Boost — Grow",
  referrals: "Referrals",
  polls: "Polls",
  t4: "T4 / Recommendations",
};
