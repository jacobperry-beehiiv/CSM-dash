import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { searchWorkspaces } from "@/lib/data/child-workspace-metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/search?q=<text or workspace_id>
 *
 * Typeahead for the "add child workspace" picker. Searches ALL beehiiv
 * organizations, not the customer book — the whole point is to find a
 * workspace the book doesn't contain.
 *
 * Gated on `child-workspaces` because it is a lookup across every
 * organization on the platform (~667k), which is a wider read than
 * anything else the dashboard exposes and shouldn't be open to any
 * signed-in viewer just because this endpoint happens to exist.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("child-workspaces", email))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    const results = await searchWorkspaces(q);
    return NextResponse.json({ results });
  } catch (e) {
    console.error("[workspaces/search] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Search failed" },
      { status: 500 }
    );
  }
}
