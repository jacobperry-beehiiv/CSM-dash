import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/customer-overrides/refresh-csm
 *
 * DEPRECATED. The Metabase snapshot (q10600) is now the sole source
 * of truth for the dashboard's CSM column — `applyOverride` no longer
 * layers anything onto `customer_success_manager`, so writing here
 * would be pure noise.
 *
 * To update the dashboard's CSM column:
 *   1. Update the `customer_success_manager` custom property on the
 *      company in HubSpot.
 *   2. Hit the global Refresh button at the top of the dashboard
 *      (dispatches the sync-data workflow). The next render pulls
 *      the fresh value via q10600.
 *
 * Historical behavior: this endpoint used to read HubSpot and write
 * the CSM into the customer-overrides KV. The override layer is no
 * longer applied to the CSM field, so the write has no effect on the
 * dashboard's view. Returning 410 Gone so any client still calling
 * this sees a clear "no-op" response instead of a silent success.
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
        "Per-row Refresh CSM is no longer supported. The Metabase snapshot is the sole source of truth for the CSM field. Update customer_success_manager in HubSpot, then click the global Refresh button at the top of the dashboard to pull a fresh sync.",
    },
    { status: 410 }
  );
}
