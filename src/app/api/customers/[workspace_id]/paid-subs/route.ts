import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DB, runNativeQuery } from "@/lib/metabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/customers/[workspace_id]/paid-subs
 *
 * Surfaces a workspace's paid-subscription footprint: which tiers have
 * active subscribers and total revenue earned via beehiiv's paid-subs
 * product. The "active paid subscriber" definition matches Metabase
 * questions 3402/3403/3404 (the canonical Paid Subscriptions Dashboard
 * queries):
 *
 *   subscriptions
 *     JOIN subscription_tiers ON subscriptions.id = subscription_tiers.subscription_id
 *     JOIN tiers              ON subscription_tiers.tier_id = tiers.id
 *   WHERE subscriptions.status = 'active'
 *     AND subscriptions.deleted_at IS NULL
 *
 * Revenue mirrors q3378/q3382: `SUM(cash)` from
 * `materialized_stripe_saas_metrics_fallback` filtered to this
 * workspace's publication IDs. The fallback variant is the
 * non-materialized branch when the materialized view is rebuilding;
 * picking the fallback intentionally — it stays queryable when the
 * primary is mid-refresh.
 *
 * Scope: one organization → handful of publications → at most a few
 * dozen tiers. Well under Metabase's 2000-row /api/dataset cap, so a
 * single round-trip per query is fine.
 *
 * Auth: session-only. Paid-sub revenue is sensitive customer data.
 */

interface TierWithSubs {
  tier_id: string;
  tier_name: string;
  publication_id: string;
  publication_name: string;
  active_subs: number;
}

interface ApiResponse {
  tiers: TierWithSubs[];
  total_active_subs: number;
  total_revenue_lifetime: number;
  /** Diagnostic: # of publications in the workspace. Helps the UI
   *  decide between "no paid tiers configured" vs "no workspace". */
  publication_count: number;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ workspace_id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  const { workspace_id } = await ctx.params;
  const orgId = (workspace_id ?? "").replace(/'/g, "''");
  if (!orgId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  try {
    // ─── Tiers with active subscribers ───────────────────────────────
    // HAVING clause filters to only tiers with >0 active subs, which is
    // exactly the cohort the CSM cares about (an empty tier the
    // publisher defined but no one bought into is noise).
    const tierSql = `
      SELECT
        t.id::text              AS tier_id,
        t.name                  AS tier_name,
        p.id::text              AS publication_id,
        p.name                  AS publication_name,
        COUNT(*)                AS active_subs
      FROM tiers t
      JOIN publications p
        ON p.id = t.publication_id
      JOIN subscription_tiers st
        ON st.tier_id = t.id
      JOIN subscriptions s
        ON s.id = st.subscription_id
       AND s.status = 'active'
       AND s.deleted_at IS NULL
      WHERE p.organization_id = '${orgId}'
        AND p.deleted_at IS NULL
      GROUP BY t.id, t.name, p.id, p.name
      HAVING COUNT(*) > 0
      ORDER BY active_subs DESC, p.name, t.name
    `;

    // ─── Lifetime revenue across all publications in the workspace ──
    // The materialized metrics table is partitioned by publication_id.
    // Scoping to one workspace's pubs (typically 1-10) keeps this fast
    // even though it's a sum over potentially many months of data.
    const revenueSql = `
      SELECT COALESCE(SUM(m.cash), 0) AS revenue_lifetime
      FROM materialized_stripe_saas_metrics_fallback m
      JOIN publications p
        ON p.id = m.publication_id
      WHERE p.organization_id = '${orgId}'
        AND m.cash > 0
    `;

    // ─── Publication count (cheap sanity check for the UI) ──────────
    const pubCountSql = `
      SELECT COUNT(*) AS publication_count
      FROM publications
      WHERE organization_id = '${orgId}'
        AND deleted_at IS NULL
    `;

    const [tierRows, revenueRows, pubCountRows] = await Promise.all([
      runNativeQuery(DB.POSTGRES, tierSql),
      runNativeQuery(DB.POSTGRES, revenueSql),
      runNativeQuery(DB.POSTGRES, pubCountSql),
    ]);

    const tiers: TierWithSubs[] = (tierRows as Array<Record<string, unknown>>).map(
      (r) => ({
        tier_id: String(r.tier_id ?? ""),
        tier_name: String(r.tier_name ?? ""),
        publication_id: String(r.publication_id ?? ""),
        publication_name: String(r.publication_name ?? ""),
        active_subs: Number(r.active_subs ?? 0),
      })
    );

    const total_active_subs = tiers.reduce((sum, t) => sum + t.active_subs, 0);
    const total_revenue_lifetime = Number(
      (revenueRows[0]?.revenue_lifetime as number | string | undefined) ?? 0
    );
    const publication_count = Number(
      (pubCountRows[0]?.publication_count as number | string | undefined) ?? 0
    );

    const payload: ApiResponse = {
      tiers,
      total_active_subs,
      total_revenue_lifetime,
      publication_count,
    };

    return NextResponse.json(payload, {
      headers: {
        // 5-min cache mirrors the publications endpoint. Paid-sub
        // counts move slowly (a CSM doesn't need to see real-time);
        // staleness here is the safer default vs hammering Metabase.
        "Cache-Control": "private, max-age=300, stale-while-revalidate=900",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
