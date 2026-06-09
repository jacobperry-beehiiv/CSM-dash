import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  invalidateCustomerCache,
  loadCustomers,
} from "@/lib/data/load-customers";
import { setOverride } from "@/lib/data/customer-overrides";
import { searchCompaniesByStripeIds } from "@/lib/integrations/hubspot";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/hubspot/resolve-by-stripe
 *
 * Manual recovery path when the nightly sync hasn't caught up to a
 * fresh Stripe-ID addition in HubSpot — or when a HubSpot company
 * was merged / recreated and the snapshot's `hubspot_company_id` is
 * pointing at a tombstone. Looks up the customer's Stripe ID in
 * HubSpot via the `stripe_customer_id` custom property, writes the
 * resolved company ID into the customer-overrides KV, and invalidates
 * the load-customers cache so the next render picks it up.
 *
 * The override carries `hubspot_link_source: "stripe_id"` so the
 * detail-panel badge flips to "🔗 HubSpot linked" immediately. The
 * other write paths (refresh-csm, post-note-to-HubSpot, /update-csm)
 * read the override's `hubspot_company_id` via applyOverride() so they
 * also unblock the moment this endpoint succeeds.
 *
 * Body: { workspace_id: string }
 *
 * Response shapes:
 *   200 { ok: true, before, after, hubspot_company_id, resolved_via_stripe_id }
 *   400 invalid body / no stripe_customer_id on the row
 *   404 no HubSpot company has that Stripe ID set on `stripe_customer_id`
 *
 * Auth: NextAuth session. The viewer's email is stored on the
 * override as `hubspot_link_refreshed_by` for audit.
 */

interface PostBody {
  workspace_id?: string;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const viewer = session.user.email.toLowerCase();

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON" },
      { status: 400 }
    );
  }
  const workspaceId = body.workspace_id?.trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  const list = await loadCustomers();
  const customer = list.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json(
      { error: `No customer row found for workspace_id=${workspaceId}` },
      { status: 404 }
    );
  }
  const stripeId = customer.stripe_customer_id?.trim() || null;
  if (!stripeId) {
    return NextResponse.json(
      {
        error:
          "This customer has no Stripe customer ID on file — can't resolve to HubSpot via Stripe. Add the Stripe ID in Metabase q10600 or HubSpot before retrying.",
      },
      { status: 400 }
    );
  }

  let matches: Awaited<ReturnType<typeof searchCompaniesByStripeIds>>;
  try {
    matches = await searchCompaniesByStripeIds([stripeId]);
  } catch (e) {
    // Surface the full stack to Vercel logs so we can debug 502s
    // without round-tripping through the user. Likely causes:
    //   • HUBSPOT_ACCESS_TOKEN (or CLIENT_ID/CLIENT_SECRET) not set
    //     on this deployment — getAccessToken() throws synchronously
    //   • OAuth token mint failed (clientSecret rotated, etc.)
    //   • Network error reaching HubSpot
    const message = e instanceof Error ? e.message : "Unknown error";
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[hubspot/resolve-by-stripe] search failed", {
      workspace_id: workspaceId,
      stripe_customer_id: stripeId,
      viewer,
      message,
      stack,
    });
    return NextResponse.json(
      { error: `HubSpot search failed: ${message}` },
      { status: 502 }
    );
  }
  const match = matches.get(stripeId);
  if (!match) {
    return NextResponse.json(
      {
        error: `No HubSpot company has \`stripe_customer_id\` = ${stripeId}. Add the Stripe ID to the HubSpot company record before retrying.`,
      },
      { status: 404 }
    );
  }

  const before = {
    hubspot_company_id: customer.hubspot_company_id ?? null,
    hubspot_link_source: customer.hubspot_link_source ?? "none",
  };

  await setOverride(workspaceId, {
    hubspot_company_id: match.companyId,
    hubspot_link_source: "stripe_id",
    hubspot_link_refreshed_at: new Date().toISOString(),
    hubspot_link_refreshed_by: viewer,
  });
  invalidateCustomerCache();

  return NextResponse.json({
    ok: true,
    before,
    after: {
      hubspot_company_id: match.companyId,
      hubspot_link_source: "stripe_id",
    },
    hubspot_company_name: match.name,
    stripe_customer_id: stripeId,
  });
}
