import { DB, runNativeQuery } from "../metabase";
import {
  cleanArray,
  cleanText,
  daysUntil,
  type AdCampaignRow,
  type AdCampaignsReport,
} from "./ad-campaigns-types";

/**
 * Live Ad Network Campaigns.
 *
 * One row per currently-running ad network campaign, with the
 * advertiser's categorisation (content tags, targeting tags,
 * industry), tier, payout terms and goal. Feeds
 * /csm/ad-campaigns — a reference view for matching campaigns to
 * publications, not a per-CSM book view.
 *
 * Everything is Postgres (DB 2, Swarm production replica). ~51 rows
 * and sub-second as of 2026-09-25, so the view fetches the whole set
 * once and filters client-side — that keeps facet counts instant and
 * avoids a round-trip per chip click.
 *
 * Shape notes that bit during the build (verified against live data):
 *   • `tier` is a varchar, not an int, and is NULL on at least one
 *     advertiser. Don't assume 1-4.
 *   • `geo` comes back as `[]` rather than NULL for most rows.
 *   • `goal` can be the literal "other" — the dropdown sentinel left
 *     when someone picks Other and never fills `goal_other`. Treated
 *     as unset; see EMPTY_SENTINELS in ad-campaigns-types.
 */

/** Two rules define "currently running":
 *
 *    campaign_status = 'active'  — only trustworthy for CURRENT
 *      campaigns. It's NULL on most historical rows, so any
 *      backward-looking view has to use the window dates instead.
 *    window_always_on OR window_end_date >= now()
 *
 *  Campaigns whose flight hasn't started are deliberately included
 *  and flagged `not_started` rather than filtered — a CSM pitching
 *  inventory wants to see what's about to run.
 *
 *  `NULLIF(..., 0)` on every rate and goal: a 0 in these columns
 *  means "not set yet", and rendering it as $0.00 would read as a
 *  free campaign.
 */
const CAMPAIGNS_SQL = `
WITH active AS (
  SELECT c.id, c.advertiser_id, c.name, c.payout_model,
         c.window_start_date, c.window_end_date, c.tags,
         COALESCE(NULLIF(c.promoted_item_other, ''), c.promoted_item) AS promoted_item,
         COALESCE(NULLIF(c.goal_other, ''), c.goal)                   AS goal,
         c.geographical_requirements,
         NULLIF(c.cost_per_click_cents, 0)  AS cpc_cents,
         NULLIF(c.cost_per_mille_cents, 0)  AS cpm_cents,
         NULLIF(c.clicks_goal, 0)           AS clicks_goal,
         NULLIF(c.impressions_goal, 0)      AS impressions_goal
  FROM ad_network_campaigns c
  WHERE c.deleted_at IS NULL
    AND c.campaign_status = 'active'
    AND (c.window_always_on OR c.window_end_date >= now())
),
industry AS (
  SELECT ai.advertiser_id,
         array_agg(DISTINCT i.name::text) AS industries,
         array_agg(DISTINCT g.name::text) FILTER (WHERE g.name IS NOT NULL) AS industry_groups
  FROM ad_network_advertiser_industries ai
  JOIN ad_network_industries i ON i.id = ai.industry_id AND i.deleted_at IS NULL
  LEFT JOIN ad_network_industry_groups g ON g.id = i.industry_group_id AND g.deleted_at IS NULL
  WHERE ai.deleted_at IS NULL
    AND ai.advertiser_id IN (SELECT advertiser_id FROM active)
  GROUP BY 1
),
content_tags AS (
  SELECT x.content_taggable_id AS advertiser_id,
         array_agg(t.name ORDER BY x.score DESC) AS content_tags
  FROM (
    SELECT content_taggable_id, tag_id, score,
           row_number() OVER (PARTITION BY content_taggable_id ORDER BY score DESC) AS rn
    FROM ad_network_internal_content_tags
    WHERE content_taggable_type = 'AdNetwork::Advertiser'
      AND content_taggable_id IN (SELECT advertiser_id FROM active)
  ) x
  JOIN tags t ON t.id = x.tag_id
  WHERE x.rn <= 5
  GROUP BY 1
),
targeting_tags AS (
  SELECT a.id AS campaign_id, array_agg(t.name ORDER BY t.name) AS targeting_tags
  FROM active a
  CROSS JOIN LATERAL unnest(a.tags) AS tag_id
  JOIN tags t ON t.id::text = tag_id
  GROUP BY 1
)
SELECT a.id::text AS campaign_id, adv.id::text AS advertiser_id,
       adv.name AS advertiser, adv.tier,
       a.name AS campaign, a.payout_model,
       a.window_start_date, a.window_end_date,
       (a.window_start_date > now()) AS not_started,
       ct.content_tags, tt.targeting_tags,
       ind.industry_groups, ind.industries,
       a.promoted_item, a.goal, a.geographical_requirements AS geo,
       a.cpc_cents, a.cpm_cents, a.clicks_goal, a.impressions_goal
FROM active a
JOIN ad_network_advertisers adv ON adv.id = a.advertiser_id
LEFT JOIN industry       ind ON ind.advertiser_id = a.advertiser_id
LEFT JOIN content_tags   ct  ON ct.advertiser_id  = a.advertiser_id
LEFT JOIN targeting_tags tt  ON tt.campaign_id    = a.id
ORDER BY adv.name, a.name
LIMIT 500
`;

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function asIso(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export async function runAdCampaigns(): Promise<AdCampaignsReport> {
  const raw = await runNativeQuery(DB.POSTGRES, CAMPAIGNS_SQL);
  const rows: AdCampaignRow[] = raw.map((r) => {
    const endDate = asIso(r.window_end_date);
    return {
      campaign_id: String(r.campaign_id ?? ""),
      advertiser_id: String(r.advertiser_id ?? ""),
      advertiser: cleanText(r.advertiser) ?? "(unnamed advertiser)",
      // Kept as a string — it's a varchar upstream, and coercing to a
      // number would turn a NULL tier into 0 and sort it alongside
      // real tiers.
      tier: cleanText(r.tier),
      campaign: cleanText(r.campaign) ?? "(unnamed campaign)",
      payout_model: cleanText(r.payout_model),
      window_start_date: asIso(r.window_start_date),
      window_end_date: endDate,
      not_started: r.not_started === true,
      content_tags: cleanArray(r.content_tags),
      targeting_tags: cleanArray(r.targeting_tags),
      industry_groups: cleanArray(r.industry_groups),
      industries: cleanArray(r.industries),
      promoted_item: cleanText(r.promoted_item),
      goal: cleanText(r.goal),
      geo: cleanArray(r.geo),
      cpc_cents: asNumber(r.cpc_cents),
      cpm_cents: asNumber(r.cpm_cents),
      clicks_goal: asNumber(r.clicks_goal),
      impressions_goal: asNumber(r.impressions_goal),
      days_until_end: daysUntil(endDate),
    };
  });
  return { rows, fetched_at: new Date().toISOString() };
}
