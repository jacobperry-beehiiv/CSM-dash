import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadZendeskOverlay } from "@/lib/data/zendesk-tickets";

export const dynamic = "force-dynamic";

/**
 * GET /api/zendesk-tickets
 *
 * Returns the whole cached Zendesk overlay — one blob with per-
 * workspace 30-day counters + recent-ticket samples. The panels
 * consume the blob client-side and look up rows by workspace_id.
 *
 * Auth: signed-in session only. No admin gate — the panels that
 * consume this are already CSM-scoped and non-CSMs don't reach them.
 *
 * The overlay lives in KV; this endpoint is a plain read. Refresh
 * lives at /api/zendesk-tickets/refresh (workflow-gated, since it
 * hits Metabase).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const blob = await loadZendeskOverlay();
  return NextResponse.json(blob);
}
