import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadAllUpgradeAnalyses } from "@/lib/data/upgrade-analysis-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/upgrade-analysis/list
 *
 * Returns every stored scan (report + last_scanned_at). Used by the
 * review-queue tab to render pubs with `escalation.needed === true`;
 * filtering is done client-side because the queue view is small
 * enough to hydrate in one shot and the filter chip strip needs the
 * cleared-verdict rows too when toggled.
 *
 * Gated on the upgrade-analysis feature flag.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("upgrade-analysis", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const scans = await loadAllUpgradeAnalyses();
    // Sort most-recently-scanned first — matches how D&C works the queue.
    scans.sort(
      (a, b) => Date.parse(b.last_scanned_at) - Date.parse(a.last_scanned_at)
    );
    return NextResponse.json({ scans });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[upgrade-analysis/list] 500", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
