import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { updateOrphanStatus } from "@/lib/data/enterprise-requests";
import type { OrphanedShipment } from "@/lib/data/enterprise-requests-types";

export const dynamic = "force-dynamic";

/**
 * POST /api/enterprise-requests/orphans/apply
 *
 * Body: `{ ship_permalink, status }` where status is one of
 * `"pending"` (re-open), `"not_customer_facing"`, `"dismissed"`.
 *
 * Session-auth + flag-gated.
 */

interface Body {
  ship_permalink?: string;
  status?: OrphanedShipment["status"];
}

const ALLOWED_STATUSES: OrphanedShipment["status"][] = [
  "pending",
  "not_customer_facing",
  "dismissed",
];

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("enterprise-requests", email))) {
    return NextResponse.json(
      { error: "Enterprise Request Loop is not enabled for you." },
      { status: 403 }
    );
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const permalink = (body.ship_permalink ?? "").trim();
  const status = body.status;
  if (!permalink || !status || !ALLOWED_STATUSES.includes(status)) {
    return NextResponse.json(
      {
        error:
          "ship_permalink and status ('pending' | 'not_customer_facing' | 'dismissed') are required",
      },
      { status: 400 }
    );
  }
  await updateOrphanStatus(permalink, status, email);
  return NextResponse.json({ ok: true, status });
}
