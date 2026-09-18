import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { computeBeehiivUsage } from "@/lib/qbr-charts/beehiiv-usage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/qbr-charts/beehiiv-usage?workspace_id=<uuid>
 *
 * Returns the beehiiv Usage Y/N feature-adoption report for one
 * workspace. Feeds the "beehiiv Usage" table on the QBR tab
 * (top-right block in the customer-deck screenshot). Signed-in
 * users only; no admin gate — every CSM can read their own book's
 * usage picture.
 *
 * Single Postgres round-trip against beehiiv's public schema,
 * scored 0-100 by (# active features / # total).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspace_id") ?? "").trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "Missing workspace_id" },
      { status: 400 }
    );
  }
  try {
    const report = await computeBeehiivUsage(workspaceId);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
