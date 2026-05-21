import { NextResponse } from "next/server";
import { getFeatureUpdates } from "@/lib/feature-updates/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/feature-updates → the stored, deduped feature-update feed
 *                            (newest first) plus the last-sync timestamp
 *                            so the panel can show "Synced 12 minutes ago."
 *
 * No auth gate here — the panel is shown on the signed-in home page and
 * the data isn't sensitive. The proxy already 302's anonymous traffic
 * away from app routes.
 */
export async function GET() {
  try {
    const list = await getFeatureUpdates();
    return NextResponse.json(list);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
