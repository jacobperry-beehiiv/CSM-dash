import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { runWinsDetection } from "@/lib/engines/wins";
import { pruneOlderThan, upsertCandidates } from "@/lib/data/wins-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/wins/detect
 *
 * Runs the Phase 1 wins detection engine, writes candidates to KV.
 * Called daily by .github/workflows/wins-detection.yml (05:15 UTC)
 * and available on-demand for signed-in admins with the wins-
 * opportunities flag on.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} OR NextAuth session
 * with the wins-opportunities feature flag enabled.
 */

async function authorize(req: Request): Promise<{
  triggeredBy: "cron" | "manual";
  email: string | null;
} | null> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${cronSecret}`) {
      return { triggeredBy: "cron", email: null };
    }
  }
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) return null;
  const enabled = await isFeatureEnabledFor("wins-opportunities", email);
  if (!enabled) return null;
  return { triggeredBy: "manual", email };
}

export async function POST(req: Request) {
  const authInfo = await authorize(req);
  if (!authInfo) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runWinsDetection();
    const persistSummary = await upsertCandidates(result.candidates);
    // Drop wins detected > 90 days ago so the KV row stays lean.
    // Anything older than that has either already been sent, been
    // dismissed, or was never acted on — none of which are
    // valuable to keep around for re-render.
    const pruned = await pruneOlderThan(90);

    return NextResponse.json({
      ok: true,
      triggered_by: authInfo.triggeredBy,
      scanned_workspaces: result.scanned_workspaces,
      scanned_publications: result.scanned_publications,
      detected: result.detected,
      suppressed_at_risk: result.suppressed_at_risk,
      suppressed_recent_send: result.suppressed_recent_send,
      persisted: persistSummary,
      pruned_old_wins: pruned,
      metrics_source: result.metrics_source,
      lookback_days: result.lookback_days,
      generated_at: result.generated_at,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[wins/detect] 500", {
      message,
      triggeredBy: authInfo.triggeredBy,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
