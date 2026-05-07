import { DB, runNativeQuery } from "../metabase";
import { loadSettings } from "../data/settings";
import type { AdGapPublicationRow, AdGapReport } from "../types";

/**
 * Ad Network Gap Analysis
 * ------------------------
 * Ports the queries from the CSM plugin's `ad-gap-analysis` skill.
 * Everything is Postgres (DB 2). Given an org-name fragment and a
 * date window, returns per-publication fill rates and portfolio-level
 * revenue-vs-potential numbers.
 */

interface OrgRow {
  id: string;
  name: string;
  owner_email: string | null;
  plan_id: number | null;
}

export async function findOrganization(
  nameFragment: string
): Promise<OrgRow[]> {
  const sanitized = nameFragment.replace(/'/g, "''");
  const sql = `
    SELECT o.id::text AS id, o.name, u.email AS owner_email, o.plan_id
    FROM public.organizations o
    LEFT JOIN public.users u ON u.id = o.owner_id
    WHERE o.name ILIKE '%${sanitized}%'
      AND o.deleted_at IS NULL
    LIMIT 10
  `;
  const rows = (await runNativeQuery(DB.POSTGRES, sql)) as unknown as OrgRow[];
  return rows;
}

export interface AdGapRunOptions {
  organizationId: string;
  /** ISO date YYYY-MM-DD inclusive */
  startDate: string;
  /** ISO date YYYY-MM-DD inclusive */
  endDate: string;
}

function addDays(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

interface PubStatsRow {
  publication_id: string;
  publication_name: string;
  subscribers: number | null;
  sends_in_period: number;
  has_ad_profile: boolean;
  ads_accepted: number;
  ads_canceled: number;
  ads_missed: number;
  actual_payout_dollars: number | null;
  estimated_payout_dollars: number | null;
  avg_actual_per_ad_dollars: number | null;
}

export async function runAdGapAnalysis(
  opts: AdGapRunOptions
): Promise<AdGapReport> {
  const orgId = opts.organizationId.replace(/'/g, "''");
  const start = opts.startDate;
  const end = opts.endDate;
  const endExclusive = addDays(end, 1);

  // Single combined query — all joins hit indexed columns so Postgres handles this fine.
  const sql = `
    WITH pubs AS (
      SELECT p.id::text AS publication_id,
             p.name AS publication_name,
             vasc.total AS subscribers
      FROM public.publications p
      LEFT JOIN public.v_active_subscription_counts vasc ON vasc.publication_id = p.id
      WHERE p.organization_id = '${orgId}'
        AND p.deleted_at IS NULL
    ),
    sends AS (
      SELECT p.id::text AS publication_id,
             COUNT(DISTINCT vsp.sent_date) AS sends_in_period
      FROM public.publications p
      LEFT JOIN public.v_sent_posts vsp
        ON vsp.publication_id = p.id
       AND vsp.sent_date >= '${start}'
       AND vsp.sent_date <= '${end}'
      WHERE p.organization_id = '${orgId}'
        AND p.deleted_at IS NULL
      GROUP BY p.id
    ),
    profiles AS (
      SELECT p.id::text AS publication_id,
             (pp.id IS NOT NULL) AS has_ad_profile
      FROM public.publications p
      LEFT JOIN public.ad_network_publication_profiles pp ON pp.publication_id = p.id
      WHERE p.organization_id = '${orgId}'
        AND p.deleted_at IS NULL
    ),
    opps AS (
      SELECT o.publication_id::text AS publication_id,
             COUNT(*) FILTER (WHERE o.status = 'accepted') AS ads_accepted,
             COUNT(*) FILTER (WHERE o.status = 'canceled') AS ads_canceled,
             COUNT(*) FILTER (WHERE o.status = 'missed') AS ads_missed,
             SUM(o.estimated_payout_cents) FILTER (WHERE o.status = 'accepted') / 100.0 AS estimated_payout_dollars
      FROM public.ad_network_opportunities o
      WHERE o.publication_id IN (
        SELECT id FROM public.publications WHERE organization_id = '${orgId}' AND deleted_at IS NULL
      )
        AND o.selected_date >= '${start}'
        AND o.selected_date < '${endExclusive}'
        AND o.deleted_at IS NULL
      GROUP BY o.publication_id
    ),
    disb AS (
      SELECT o.publication_id::text AS publication_id,
             SUM(d.approved_amount_cents) / 100.0 AS actual_payout_dollars,
             ROUND(AVG(d.approved_amount_cents) / 100.0, 2) AS avg_actual_per_ad_dollars
      FROM public.ad_network_opportunities o
      JOIN public.ad_network_disbursements d
        ON d.opportunity_id = o.id
       AND d.deleted_at IS NULL
      WHERE o.publication_id IN (
        SELECT id FROM public.publications WHERE organization_id = '${orgId}' AND deleted_at IS NULL
      )
        AND o.selected_date >= '${start}'
        AND o.selected_date < '${endExclusive}'
        AND o.status = 'accepted'
        AND o.deleted_at IS NULL
      GROUP BY o.publication_id
    )
    SELECT
      pubs.publication_id,
      pubs.publication_name,
      pubs.subscribers,
      COALESCE(sends.sends_in_period, 0) AS sends_in_period,
      COALESCE(profiles.has_ad_profile, false) AS has_ad_profile,
      COALESCE(opps.ads_accepted, 0) AS ads_accepted,
      COALESCE(opps.ads_canceled, 0) AS ads_canceled,
      COALESCE(opps.ads_missed, 0) AS ads_missed,
      COALESCE(disb.actual_payout_dollars, 0) AS actual_payout_dollars,
      COALESCE(opps.estimated_payout_dollars, 0) AS estimated_payout_dollars,
      disb.avg_actual_per_ad_dollars
    FROM pubs
    LEFT JOIN sends ON sends.publication_id = pubs.publication_id
    LEFT JOIN profiles ON profiles.publication_id = pubs.publication_id
    LEFT JOIN opps ON opps.publication_id = pubs.publication_id
    LEFT JOIN disb ON disb.publication_id = pubs.publication_id
    ORDER BY pubs.subscribers DESC NULLS LAST
  `;

  const rows = (await runNativeQuery(DB.POSTGRES, sql)) as unknown as PubStatsRow[];

  const orgSql = `
    SELECT o.id::text AS id, o.name, u.email AS owner_email
    FROM public.organizations o
    LEFT JOIN public.users u ON u.id = o.owner_id
    WHERE o.id = '${orgId}'
    LIMIT 1
  `;
  const orgRows = (await runNativeQuery(DB.POSTGRES, orgSql)) as unknown as OrgRow[];
  const org = orgRows[0];

  const publications: AdGapPublicationRow[] = rows.map((r) => {
    const total = r.ads_accepted + r.ads_canceled + r.ads_missed;
    return {
      publication_id: r.publication_id,
      publication_name: r.publication_name,
      subscribers: r.subscribers,
      sends_in_period: Number(r.sends_in_period),
      has_ad_profile: r.has_ad_profile,
      ads_accepted: Number(r.ads_accepted),
      ads_canceled: Number(r.ads_canceled),
      ads_missed: Number(r.ads_missed),
      fill_rate: total > 0 ? r.ads_accepted / total : null,
      actual_payout_dollars: Number(r.actual_payout_dollars ?? 0),
      estimated_payout_dollars: Number(r.estimated_payout_dollars ?? 0),
      avg_actual_per_ad_dollars: r.avg_actual_per_ad_dollars,
    };
  });

  // ─── Revenue / potential math ───────────────────────────────────────
  // Methodology (per docs/ad-gap-revenue-methodology.md), with a
  // configurable system-rate fallback so customers with no internal ad
  // history still see a directional potential-earnings estimate.
  //
  // Per-ad rate cascade:
  //   1. The pub's own avg_actual_per_ad if it has accepted ads
  //   2. Portfolio-weighted average (sum-actual / sum-accepted) if the
  //      portfolio has any payout history at all
  //   3. settings.thresholds.ad_default_rate_per_k_subs_usd × subs/1000
  //      — used when steps 1+2 produce 0 (e.g. customer never enrolled
  //      or never had a single ad). Tunable on /settings/general.
  //
  // Per pub: potential = total_opportunities × per_ad_rate.
  // For sending pubs with no opportunities yet, fall back to
  // sends × per_ad_rate as a directional projection.

  const portfolioActual = publications.reduce(
    (s, p) => s + p.actual_payout_dollars,
    0
  );
  const portfolioAccepted = publications.reduce(
    (s, p) => s + p.ads_accepted,
    0
  );
  const portfolioAvgPerAd =
    portfolioAccepted > 0 ? portfolioActual / portfolioAccepted : 0;

  const settings = await loadSettings();
  const defaultRatePerKSubs =
    settings.thresholds.ad_default_rate_per_k_subs_usd ?? 5;

  function perAdRate(p: AdGapPublicationRow): number {
    if (p.avg_actual_per_ad_dollars && p.avg_actual_per_ad_dollars > 0) {
      return p.avg_actual_per_ad_dollars;
    }
    if (portfolioAvgPerAd > 0) return portfolioAvgPerAd;
    // System fallback: $/K subs × subscriber count, divided by 1K.
    const subs = p.subscribers ?? 0;
    return (subs / 1000) * defaultRatePerKSubs;
  }

  const portfolioPotential = publications.reduce((s, p) => {
    const rate = perAdRate(p);
    if (rate <= 0) return s;
    const totalOpps = p.ads_accepted + p.ads_canceled + p.ads_missed;
    if (totalOpps > 0) return s + totalOpps * rate;
    if (p.sends_in_period > 0) return s + p.sends_in_period * rate;
    return s;
  }, 0);

  const zeroAd = publications.filter(
    (p) => p.ads_accepted === 0 && p.sends_in_period > 0
  );

  return {
    organization_id: opts.organizationId,
    organization_name: org?.name ?? "unknown",
    owner_email: org?.owner_email ?? null,
    total_subscribers: publications.reduce(
      (s, p) => s + (p.subscribers ?? 0),
      0
    ),
    publications,
    portfolio_actual_dollars: portfolioActual,
    portfolio_potential_at_full_fill_dollars: portfolioPotential,
    zero_ad_sending_pubs: zeroAd,
  };
}
