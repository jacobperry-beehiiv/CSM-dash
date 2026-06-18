import { DB, runNativeQuery } from "../metabase";
import { isDemoMode } from "../demo/mode";

/** All-zeros FeatureUtilization for DEMO_MODE callers. Keeps every
 *  field at its empty-state default so the panel renders the
 *  "no signals yet" UI instead of throwing on a malformed Metabase
 *  response. */
function buildEmptyFeatureUtilization(
  organizationId: string
): FeatureUtilization {
  return {
    organization_id: organizationId,
    generated_at: new Date().toISOString(),
    mcp_calls: 0,
    mcp_last_call: null,
    podcast_shows: 0,
    podcast_episodes: 0,
    podcast_last_episode: null,
    ad_network_count: 0,
    ad_network_last_run: null,
    ad_network_revenue_usd: 0,
    direct_sponsorship_count: 0,
    direct_sponsorship_last_run: null,
    direct_sponsorship_revenue_usd: 0,
    automations_total: 0,
    automations_active: 0,
    automations_last_created: null,
    automations_last_edited: null,
    automations_last_published: null,
    segments_total: 0,
    segments_last_created: null,
    segments_last_used: null,
    boost_monetize_agreements: 0,
    boost_monetize_last_send: null,
    boost_monetize_potential_payout_usd: 0,
    boost_grow_offers: 0,
    boost_grow_last_offer: null,
    boost_grow_allocated_spend_usd: 0,
    referral_program_created: null,
    referral_program_active: null,
    polls_total: 0,
    polls_last_created: null,
    polls_last_response: null,
    t4_completed_at: null,
    t4_status: null,
    t4_active_recs: 0,
    t4_total_recs: 0,
  };
}

/**
 * Consolidated Enterprise Feature Utilization
 * --------------------------------------------
 * Combines 10 confirmed feature queries from
 * `Enterprise Feature Utilization Queries.txt` into a single Postgres query.
 *
 * Reductions vs the original:
 *   • Queries #3 (programmatic ad network) and #4 (direct sponsorships) had
 *     identical join shape; merged via FILTER (WHERE provision_type …).
 *   • All queries used `WHERE pub.organization_id = X` to scope publications;
 *     hoisted once into a shared `org_pubs` CTE.
 *   • Each feature is its own CTE returning a single row; they cross-join in
 *     the final SELECT, giving one row per call with all features as columns.
 *
 * Skipped (per file notes):
 *   • #7 paid tiers — `public.tiers` table name unconfirmed
 *   • #10 last referral conversion — cohort_analysis schema unconfirmed
 *   • #13 surveys / #14 web builder — out of scope
 */

export interface FeatureUtilization {
  organization_id: string;
  generated_at: string;

  // 1. MCP
  mcp_calls: number;
  mcp_last_call: string | null;

  // 2. Podcasts
  podcast_shows: number;
  podcast_episodes: number;
  podcast_last_episode: string | null;

  // 3. Ad network (programmatic)
  ad_network_count: number;
  ad_network_last_run: string | null;
  ad_network_revenue_usd: number;

  // 4. Direct sponsorships
  direct_sponsorship_count: number;
  direct_sponsorship_last_run: string | null;
  direct_sponsorship_revenue_usd: number;

  // 5. Automations
  automations_total: number;
  automations_active: number;
  automations_last_created: string | null;
  automations_last_edited: string | null;
  automations_last_published: string | null;

  // 6. Segments
  segments_total: number;
  segments_last_created: string | null;
  segments_last_used: string | null;

  // 8. Boost — Monetize
  boost_monetize_agreements: number;
  boost_monetize_last_send: string | null;
  boost_monetize_potential_payout_usd: number;

  // 9. Boost — Grow
  boost_grow_offers: number;
  boost_grow_last_offer: string | null;
  boost_grow_allocated_spend_usd: number;

  // 10. Referral program (program-level only — see file note)
  referral_program_created: string | null;
  referral_program_active: boolean | null;

  // 11. Polls
  polls_total: number;
  polls_last_created: string | null;
  polls_last_response: string | null;

  // 12. T4 / Recommendations
  t4_completed_at: string | null;
  t4_status: string | null;
  t4_active_recs: number;
  t4_total_recs: number;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function buildSql(orgId: string): string {
  const o = quote(orgId);
  return `
    WITH org_pubs AS (
      SELECT id
      FROM public.publications
      WHERE organization_id = ${o}
        AND deleted_at IS NULL
    ),
    mcp AS (
      SELECT
        COUNT(*)::int AS mcp_calls,
        MAX(created_at) AS mcp_last_call
      FROM public.mcp_audit_logs
      WHERE organization_id = ${o}
    ),
    podcasts AS (
      SELECT
        COUNT(DISTINCT ps.id)::int AS podcast_shows,
        COUNT(pe.id)::int          AS podcast_episodes,
        MAX(pe.published_at)        AS podcast_last_episode
      FROM public.podcast_shows ps
      LEFT JOIN public.podcast_episodes pe
        ON pe.podcast_show_id = ps.id
        AND pe.status = 'published'
        AND pe.deleted_at IS NULL
      WHERE ps.deleted_at IS NULL
        AND ps.publication_id IN (SELECT id FROM org_pubs)
    ),
    ad_combined AS (
      SELECT
        -- Programmatic (#3): non-direct, not rejected/cancelled
        COUNT(DISTINCT opp.id) FILTER (
          WHERE (opp.provision_type IS NULL OR opp.provision_type <> 'direct')
            AND opp.status NOT IN ('rejected','cancelled')
        )::int AS ad_network_count,
        MAX(opp.selected_date) FILTER (
          WHERE (opp.provision_type IS NULL OR opp.provision_type <> 'direct')
            AND opp.status NOT IN ('rejected','cancelled')
        ) AS ad_network_last_run,
        COALESCE(SUM(d.approved_amount_cents) FILTER (
          WHERE (opp.provision_type IS NULL OR opp.provision_type <> 'direct')
        ), 0) / 100.0 AS ad_network_revenue_usd,

        -- Direct sponsorships (#4)
        COUNT(DISTINCT opp.id) FILTER (
          WHERE opp.provision_type = 'direct'
        )::int AS direct_sponsorship_count,
        MAX(opp.selected_date) FILTER (
          WHERE opp.provision_type = 'direct'
        ) AS direct_sponsorship_last_run,
        COALESCE(SUM(d.approved_amount_cents) FILTER (
          WHERE opp.provision_type = 'direct'
        ), 0) / 100.0 AS direct_sponsorship_revenue_usd
      FROM public.ad_network_opportunities opp
      LEFT JOIN public.ad_network_disbursements d
        ON d.opportunity_id = opp.id
        AND d.deleted_at IS NULL
      WHERE opp.publication_id IN (SELECT id FROM org_pubs)
        AND opp.deleted_at IS NULL
    ),
    automations AS (
      SELECT
        COUNT(*)::int AS automations_total,
        COUNT(*) FILTER (WHERE state = 'active')::int AS automations_active,
        MAX(created_at) AS automations_last_created,
        MAX(updated_at) AS automations_last_edited,
        MAX(published_at) AS automations_last_published
      FROM public.automations
      WHERE publication_id IN (SELECT id FROM org_pubs)
        AND deleted_at IS NULL
        AND template = FALSE
    ),
    segments AS (
      SELECT
        COUNT(*)::int AS segments_total,
        MAX(created_at) AS segments_last_created,
        MAX(user_touched_at) AS segments_last_used
      FROM public.segments
      WHERE publication_id IN (SELECT id FROM org_pubs)
        AND deleted_at IS NULL
    ),
    boost_monetize AS (
      SELECT
        COUNT(DISTINCT ba.id)::int AS boost_monetize_agreements,
        MAX(bs.accepted_at) AS boost_monetize_last_send,
        COALESCE(SUM(bs.max_payout_cents), 0) / 100.0
          AS boost_monetize_potential_payout_usd
      FROM public.boost_agreements ba
      LEFT JOIN public.boost_sends bs
        ON bs.boost_agreement_id = ba.id
      WHERE ba.publication_id IN (SELECT id FROM org_pubs)
        AND ba.status = 'accepted'
    ),
    boost_grow AS (
      SELECT
        COUNT(DISTINCT id)::int AS boost_grow_offers,
        MAX(created_at) AS boost_grow_last_offer,
        COALESCE(SUM(max_spend_cents), 0) / 100.0
          AS boost_grow_allocated_spend_usd
      FROM public.boost_offers
      WHERE publication_id IN (SELECT id FROM org_pubs)
    ),
    referrals AS (
      SELECT
        MAX(created_at) AS referral_program_created,
        BOOL_OR(disabled_at IS NULL) AS referral_program_active
      FROM public.referral_programs
      WHERE publication_id IN (SELECT id FROM org_pubs)
        AND deleted_at IS NULL
    ),
    polls AS (
      SELECT
        COUNT(DISTINCT p.id)::int AS polls_total,
        MAX(p.created_at) AS polls_last_created,
        MAX(pr.created_at) AS polls_last_response
      FROM public.polls p
      LEFT JOIN public.poll_responses pr
        ON pr.poll_id = p.id
        AND pr.deleted_at IS NULL
      WHERE p.publication_id IN (SELECT id FROM org_pubs)
        AND p.deleted_at IS NULL
    ),
    t4 AS (
      SELECT
        MAX(rc.onboarding_completed_at) AS t4_completed_at,
        MAX(rc.onboarding_status) AS t4_status,
        COALESCE((
          SELECT COUNT(DISTINCT r.id)::int
          FROM public.recommendations r
          WHERE r.publication_id IN (SELECT id FROM org_pubs)
            AND r.status = 'active'
        ), 0) AS t4_active_recs,
        COALESCE((
          SELECT COUNT(DISTINCT r.id)::int
          FROM public.recommendations r
          WHERE r.publication_id IN (SELECT id FROM org_pubs)
        ), 0) AS t4_total_recs
      FROM public.recommendation_configurations rc
      WHERE rc.publication_id IN (SELECT id FROM org_pubs)
    )
    SELECT
      ${o}::text AS organization_id,
      mcp.*,
      podcasts.*,
      ad_combined.*,
      automations.*,
      segments.*,
      boost_monetize.*,
      boost_grow.*,
      referrals.*,
      polls.*,
      t4.*
    FROM mcp, podcasts, ad_combined, automations, segments,
         boost_monetize, boost_grow, referrals, polls, t4
  `;
}

const cache = new Map<string, { expires: number; data: FeatureUtilization }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function runFeatureUtilization(
  organizationId: string
): Promise<FeatureUtilization> {
  if (!organizationId) {
    throw new Error("organizationId is required");
  }

  // Demo mode — skip the per-workspace Metabase query entirely.
  // Returning a zero-valued FeatureUtilization keeps the caller's
  // contract intact (the UI renders the panel with empty signals)
  // and avoids the UUID-cast error Metabase throws on demo IDs like
  // "ws-demo-001-morning-brew-makers".
  if (isDemoMode()) {
    return buildEmptyFeatureUtilization(organizationId);
  }

  const now = Date.now();
  const cached = cache.get(organizationId);
  if (cached && cached.expires > now) return cached.data;

  const sql = buildSql(organizationId);
  const rows = (await runNativeQuery(DB.POSTGRES, sql)) as unknown as Array<
    Record<string, unknown>
  >;
  const row = rows[0] ?? {};

  const num = (k: string): number => {
    const v = row[k];
    if (v == null) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const str = (k: string): string | null => {
    const v = row[k];
    return v == null ? null : String(v);
  };
  const bool = (k: string): boolean | null => {
    const v = row[k];
    if (v == null) return null;
    return Boolean(v);
  };

  const result: FeatureUtilization = {
    organization_id: organizationId,
    generated_at: new Date().toISOString(),

    mcp_calls: num("mcp_calls"),
    mcp_last_call: str("mcp_last_call"),

    podcast_shows: num("podcast_shows"),
    podcast_episodes: num("podcast_episodes"),
    podcast_last_episode: str("podcast_last_episode"),

    ad_network_count: num("ad_network_count"),
    ad_network_last_run: str("ad_network_last_run"),
    ad_network_revenue_usd: num("ad_network_revenue_usd"),

    direct_sponsorship_count: num("direct_sponsorship_count"),
    direct_sponsorship_last_run: str("direct_sponsorship_last_run"),
    direct_sponsorship_revenue_usd: num("direct_sponsorship_revenue_usd"),

    automations_total: num("automations_total"),
    automations_active: num("automations_active"),
    automations_last_created: str("automations_last_created"),
    automations_last_edited: str("automations_last_edited"),
    automations_last_published: str("automations_last_published"),

    segments_total: num("segments_total"),
    segments_last_created: str("segments_last_created"),
    segments_last_used: str("segments_last_used"),

    boost_monetize_agreements: num("boost_monetize_agreements"),
    boost_monetize_last_send: str("boost_monetize_last_send"),
    boost_monetize_potential_payout_usd: num("boost_monetize_potential_payout_usd"),

    boost_grow_offers: num("boost_grow_offers"),
    boost_grow_last_offer: str("boost_grow_last_offer"),
    boost_grow_allocated_spend_usd: num("boost_grow_allocated_spend_usd"),

    referral_program_created: str("referral_program_created"),
    referral_program_active: bool("referral_program_active"),

    polls_total: num("polls_total"),
    polls_last_created: str("polls_last_created"),
    polls_last_response: str("polls_last_response"),

    t4_completed_at: str("t4_completed_at"),
    t4_status: str("t4_status"),
    t4_active_recs: num("t4_active_recs"),
    t4_total_recs: num("t4_total_recs"),
  };

  cache.set(organizationId, { expires: now + CACHE_TTL_MS, data: result });
  return result;
}
