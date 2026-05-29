import { NextResponse } from "next/server";
import { loadPastDueHistory } from "@/lib/data/past-due-history";

export const dynamic = "force-dynamic";

/**
 * GET /api/past-due/history
 *   → the full historical episode map keyed by customer_id.
 *
 * Session-gated by the global /api/* proxy (no explicit auth check here
 * — the proxy redirects anonymous traffic to /login).
 */
export async function GET() {
  try {
    const map = await loadPastDueHistory();
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
