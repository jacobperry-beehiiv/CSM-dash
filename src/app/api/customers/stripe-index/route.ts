import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { DB, runNativeQuery } from "@/lib/metabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/customers/stripe-index
 *
 * Returns a flat `{ stripe_customer_id → organization_id }` map for
 * every organization that has a Stripe customer ID. The dashboard's
 * customer book (q10600 snapshot) is filtered to "book of business"
 * shape, so non-enterprise / self-serve accounts surfaced by other
 * Metabase questions (q24620 past-due, q13268 approaching) often
 * don't have an entry in the book — making it impossible to resolve
 * stripe_customer_id → workspace_id without this lookup.
 *
 * Used by Past Due + Approaching Enterprise panels to fall back when
 * customerByStripeId.get() misses: with the index, we still know the
 * workspace_id, which lets us synthesize a minimal Customer for the
 * detail panel and (critically) keep notes working.
 *
 * Volume: a few hundred thousand organizations at beehiiv scale; the
 * stripe-paying subset is a fraction of that. Two UUID strings per
 * row → typical response sits in the 1-5MB range. Cached client-side
 * for the tab session via useStripeCustomerIndex.
 *
 * Auth: session-only — Stripe customer IDs are a fingerprinting
 * vector for anonymous traffic.
 */

interface IndexRow {
  stripe_customer_id: string;
  organization_id: string;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  try {
    const rows = await runNativeQuery(
      DB.POSTGRES,
      `SELECT
         stripe_customer_id::text AS stripe_customer_id,
         id::text                 AS organization_id
       FROM public.organizations
       WHERE stripe_customer_id IS NOT NULL
         AND deleted_at IS NULL`
    );

    const stripe2ws: Record<string, string> = {};
    for (const raw of rows) {
      const r = raw as Partial<IndexRow>;
      if (
        typeof r.stripe_customer_id === "string" &&
        typeof r.organization_id === "string"
      ) {
        stripe2ws[r.stripe_customer_id] = r.organization_id;
      }
    }

    return NextResponse.json(
      { stripe2ws, count: Object.keys(stripe2ws).length },
      {
        headers: {
          "Cache-Control":
            "private, max-age=300, stale-while-revalidate=900",
        },
      }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
