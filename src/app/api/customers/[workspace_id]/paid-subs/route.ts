import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DB, runNativeQuery } from "@/lib/metabase";
import { isDemoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/customers/[workspace_id]/paid-subs
 *
 * Surfaces a workspace's paid-subscription footprint for the CSM book
 * view (/csm):
 *
 *   - Every paid tier the workspace currently OFFERS (i.e. non-default
 *     tier with at least one enabled price) — even tiers with zero
 *     subs, so the CSM sees the full pricing structure the publisher
 *     has set up, not just what's converted.
 *   - For each tier: every enabled price row (interval + amount).
 *     Beehiiv lets a tier carry multiple prices (monthly + annual,
 *     name-your-price, one-time), so we return them as a list.
 *   - Active-sub count per tier (canonical Metabase definition from
 *     q3402/3403/3404: `status='active' AND deleted_at IS NULL` joined
 *     through `subscription_tiers`).
 *   - Lifetime gross revenue across the workspace
 *     (SUM(cash) FROM materialized_stripe_saas_metrics_fallback,
 *     mirrors q3378/q3382).
 *
 * Tier visibility filter: `tiers.default = false` excludes the free
 * tier every publication has (everyone subscribing for free lands
 * there); only paid tiers are interesting here. `prices.enabled = true`
 * filters out retired pricing rows the publisher hasn't deleted.
 *
 * Scope: one organization → handful of publications → at most a few
 * dozen tier+price rows. Well under Metabase's 2000-row /api/dataset
 * cap, so one round-trip per query is fine.
 *
 * Auth: session-only. Paid-sub revenue is sensitive customer data.
 */

interface PriceRow {
  /** Stable price-row UUID — used for React keys when a tier has
   *  multiple prices listed. */
  price_id: string;
  amount_cents: number;
  currency: string;
  interval: string;
}

interface TierWithPrices {
  tier_id: string;
  tier_name: string;
  publication_id: string;
  publication_name: string;
  active_subs: number;
  prices: PriceRow[];
}

interface ApiResponse {
  tiers: TierWithPrices[];
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
  // Demo mode — return an empty paid-subs payload. The UI renders
  // "no paid tiers" without erroring; revenue/MRR boxes show $0.
  if (isDemoMode()) {
    return NextResponse.json({
      tiers: [],
      lifetime_revenue_cents: 0,
    });
  }
  const orgId = (workspace_id ?? "").replace(/'/g, "''");
  if (!orgId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  try {
    // ─── Paid tiers + their enabled prices ────────────────────────────
    // INNER JOIN to `prices` filters to tiers with at least one enabled
    // price row — i.e. tiers the publisher is currently OFFERING. If a
    // tier exists but has all its prices disabled, it's been
    // soft-retired and we hide it. Multiple prices per tier produce
    // multiple rows, aggregated in JS below.
    const tiersSql = `
      SELECT
        t.id::text          AS tier_id,
        t.name              AS tier_name,
        p.id::text          AS publication_id,
        p.name              AS publication_name,
        pr.id::text         AS price_id,
        pr.amount_cents     AS amount_cents,
        pr.currency         AS currency,
        pr.interval         AS interval
      FROM tiers t
      JOIN publications p
        ON p.id = t.publication_id
      JOIN prices pr
        ON pr.tier_id = t.id
       AND pr.enabled = true
      WHERE p.organization_id = '${orgId}'
        AND p.deleted_at IS NULL
        AND t.default = false
      ORDER BY p.name, t.name, pr.amount_cents
    `;

    // ─── Active-subscriber counts per tier ───────────────────────────
    // Matches the Metabase-canonical definition: active + non-deleted
    // subscription joined through subscription_tiers. Grouping by
    // tier_id only (publication_id falls out of the join) keeps the
    // result small.
    const subsSql = `
      SELECT
        t.id::text          AS tier_id,
        COUNT(*)            AS active_subs
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
        AND t.default = false
      GROUP BY t.id
    `;

    // ─── Lifetime revenue across all publications in the workspace ──
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

    const [tierRows, subRows, revenueRows, pubCountRows] = await Promise.all([
      runNativeQuery(DB.POSTGRES, tiersSql),
      runNativeQuery(DB.POSTGRES, subsSql),
      runNativeQuery(DB.POSTGRES, revenueSql),
      runNativeQuery(DB.POSTGRES, pubCountSql),
    ]);

    // Build an active-subs lookup keyed by tier_id.
    const subsByTier = new Map<string, number>();
    for (const r of subRows as Array<Record<string, unknown>>) {
      const tid = String(r.tier_id ?? "");
      if (!tid) continue;
      subsByTier.set(tid, Number(r.active_subs ?? 0));
    }

    // Roll up price rows into a list of tiers, one entry per tier_id.
    // The SQL ORDER BY guarantees tier rows are contiguous, but we
    // tolerate any order — Map.get keeps it cheap and order-independent.
    const tierMap = new Map<string, TierWithPrices>();
    for (const r of tierRows as Array<Record<string, unknown>>) {
      const tier_id = String(r.tier_id ?? "");
      if (!tier_id) continue;
      let entry = tierMap.get(tier_id);
      if (!entry) {
        entry = {
          tier_id,
          tier_name: String(r.tier_name ?? ""),
          publication_id: String(r.publication_id ?? ""),
          publication_name: String(r.publication_name ?? ""),
          active_subs: subsByTier.get(tier_id) ?? 0,
          prices: [],
        };
        tierMap.set(tier_id, entry);
      }
      const priceId = String(r.price_id ?? "");
      if (priceId) {
        entry.prices.push({
          price_id: priceId,
          amount_cents: Number(r.amount_cents ?? 0),
          currency: String(r.currency ?? "usd"),
          interval: String(r.interval ?? ""),
        });
      }
    }

    // Sort tiers: highest active-sub count first (matches the CSM's
    // mental "which tier is actually working"), then by publication
    // for stable grouping.
    const tiers = Array.from(tierMap.values()).sort((a, b) => {
      if (b.active_subs !== a.active_subs) {
        return b.active_subs - a.active_subs;
      }
      if (a.publication_name !== b.publication_name) {
        return a.publication_name.localeCompare(b.publication_name);
      }
      return a.tier_name.localeCompare(b.tier_name);
    });

    const total_active_subs = Array.from(subsByTier.values()).reduce(
      (sum, n) => sum + n,
      0
    );
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
