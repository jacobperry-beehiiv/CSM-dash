import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * GET /api/hubspot/check-stripe-property
 *
 * Diagnostic-only endpoint. Lists every HubSpot company property
 * whose internal name OR display label contains "stripe" so the
 * admin can confirm the exact internal name to filter on. Used
 * once during the Stripe-ID-as-canonical-join rollout — if a search
 * returns 400 "There was a problem with the request", the most
 * common cause is that the property internal name we filter on
 * (`stripe_customer_id`) differs from what's actually configured
 * in HubSpot.
 *
 * Auth: NextAuth session. The full token never leaves the server.
 *
 * Response:
 *   {
 *     matches: [{ name: "stripe_customer_id", label: "Stripe ID",
 *                 type: "string", groupName: "…",
 *                 hubspotDefined: false, calculated: false }],
 *     total_company_properties: <int>
 *   }
 *
 * If `matches` is empty, the Stripe ID isn't stored on the company
 * object at all (it might live on the deal or contact instead, or
 * not be synced yet).
 */

interface HubspotProperty {
  name: string;
  label: string;
  type: string;
  groupName?: string;
  hubspotDefined?: boolean;
  calculated?: boolean;
  description?: string;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const token =
    process.env.HUBSPOT_ACCESS_TOKEN ??
    // OAuth path not handled here — this endpoint is a quick admin
    // check and the static token covers the common case. If a deploy
    // only has OAuth creds, the call below will 401 with a clear
    // message and the admin can copy a Private App token instead.
    null;
  if (!token) {
    return NextResponse.json(
      {
        error:
          "HUBSPOT_ACCESS_TOKEN not set on this deployment. Add the Private App token to Vercel env vars to use this diagnostic.",
      },
      { status: 500 }
    );
  }

  let res: Response;
  try {
    res = await fetch(
      "https://api.hubapi.com/crm/v3/properties/companies",
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: `HubSpot fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 502 }
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json(
      {
        error: `HubSpot HTTP ${res.status}: ${body.slice(0, 600)}`,
      },
      { status: res.status }
    );
  }
  const json = (await res.json()) as { results?: HubspotProperty[] };
  const all = json.results ?? [];
  const matches = all
    .filter((p) => {
      const haystack = `${p.name} ${p.label}`.toLowerCase();
      return haystack.includes("stripe");
    })
    .map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      groupName: p.groupName,
      hubspotDefined: p.hubspotDefined,
      calculated: p.calculated,
      description: p.description,
    }));

  return NextResponse.json({
    matches,
    total_company_properties: all.length,
    note:
      matches.length === 0
        ? "No HubSpot company properties match /stripe/i. Stripe ID may live on a different object (Deal, Contact) or hasn't been added to the schema yet."
        : matches.length === 1
          ? `One match. The dashboard filters on \`stripe_customer_id\` — if that's the value of \`name\` above, the property is correctly named. If not, update searchCompaniesByStripeIds to use the actual \`name\`.`
          : `Multiple matches — pick the one whose \`name\` is what the dashboard should filter on. Currently filtering on \`stripe_customer_id\`.`,
  });
}
