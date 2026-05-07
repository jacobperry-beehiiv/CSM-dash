import { DB, runNativeQuery } from "../metabase";

/**
 * Batched ad-network roll-up — one Postgres round trip returns ad metrics
 * for many orgs at once. Used to drive the utilization-tab filters
 * ("last ad in N days", "revenue under/over $X") without firing 480
 * individual feature-utilization queries.
 *
 * Returns one row per org with:
 *   - ads_run: count of accepted+scheduled programmatic ads (excluding
 *     direct sponsorships and rejected/cancelled opportunities)
 *   - last_ad_run: most-recent selected_date for those ads
 *   - revenue_usd: sum of approved disbursements
 *
 * Same provision_type logic as engines/ad-gap.ts (programmatic only).
 */

export interface AdNetworkRollup {
  organization_id: string;
  ads_run: number;
  last_ad_run: string | null;
  revenue_usd: number;
}

function quoteList(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

const cache = new Map<string, { expires: number; data: AdNetworkRollup }>();
const TTL_MS = 10 * 60 * 1000;

export async function rollupAdNetwork(
  organizationIds: string[]
): Promise<Map<string, AdNetworkRollup>> {
  const result = new Map<string, AdNetworkRollup>();
  const now = Date.now();
  const stale: string[] = [];

  for (const id of organizationIds) {
    const hit = cache.get(id);
    if (hit && hit.expires > now) {
      result.set(id, hit.data);
    } else {
      stale.push(id);
    }
  }

  if (stale.length === 0) return result;

  // Postgres can struggle with very large IN lists — chunk into 500s.
  const chunks: string[][] = [];
  for (let i = 0; i < stale.length; i += 500) {
    chunks.push(stale.slice(i, i + 500));
  }

  for (const chunk of chunks) {
    const sql = `
      SELECT
        pub.organization_id::text AS organization_id,
        COUNT(DISTINCT opp.id) FILTER (
          WHERE (opp.provision_type IS NULL OR opp.provision_type <> 'direct')
            AND opp.status NOT IN ('rejected','cancelled')
        )::int AS ads_run,
        MAX(opp.selected_date) FILTER (
          WHERE (opp.provision_type IS NULL OR opp.provision_type <> 'direct')
            AND opp.status NOT IN ('rejected','cancelled')
        ) AS last_ad_run,
        COALESCE(SUM(d.approved_amount_cents) FILTER (
          WHERE (opp.provision_type IS NULL OR opp.provision_type <> 'direct')
        ), 0) / 100.0 AS revenue_usd
      FROM public.publications pub
      LEFT JOIN public.ad_network_opportunities opp
        ON opp.publication_id = pub.id
        AND opp.deleted_at IS NULL
      LEFT JOIN public.ad_network_disbursements d
        ON d.opportunity_id = opp.id
        AND d.deleted_at IS NULL
      WHERE pub.organization_id IN (${quoteList(chunk)})
        AND pub.deleted_at IS NULL
      GROUP BY pub.organization_id
    `;
    const rows = (await runNativeQuery(DB.POSTGRES, sql)) as unknown as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const orgId = String(row.organization_id);
      const r: AdNetworkRollup = {
        organization_id: orgId,
        ads_run: Number(row.ads_run) || 0,
        last_ad_run: row.last_ad_run ? String(row.last_ad_run) : null,
        revenue_usd: Number(row.revenue_usd) || 0,
      };
      cache.set(orgId, { expires: now + TTL_MS, data: r });
      result.set(orgId, r);
    }
    // Orgs with no ads at all won't appear in the GROUP BY result — fill
    // them in as zero so the cache is consistent.
    for (const id of chunk) {
      if (!result.has(id)) {
        const r: AdNetworkRollup = {
          organization_id: id,
          ads_run: 0,
          last_ad_run: null,
          revenue_usd: 0,
        };
        cache.set(id, { expires: now + TTL_MS, data: r });
        result.set(id, r);
      }
    }
  }

  return result;
}
