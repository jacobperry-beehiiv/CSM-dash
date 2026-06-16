import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/customer-overrides/refresh-all-csms
 *
 * DEPRECATED for the same reason as the per-row Refresh CSM endpoint.
 * See ../refresh-csm/route.ts for the policy rationale.
 *
 * The Metabase snapshot (q10600) is the sole source of truth for the
 * dashboard's CSM column. Layering HubSpot reads on top of it via
 * customer-overrides KV has caused two distinct mis-filing incidents
 * (writing hubspot_owner_id as CSM; race conditions between the per-
 * row and bulk refresh paths). To pull a fresh CSM state into the
 * dashboard: update HubSpot, hit the global Refresh button.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  return NextResponse.json(
    {
      ok: false,
      deprecated: true,
      message:
        "Bulk Refresh CSMs is no longer supported. The Metabase snapshot is the sole source of truth for the CSM field. Update customer_success_manager in HubSpot for the affected accounts, then click the global Refresh button at the top of the dashboard to pull a fresh sync.",
    },
    { status: 410 }
  );
}
