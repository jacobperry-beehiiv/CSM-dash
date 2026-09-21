import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import { runLiveQuarterCheckinSweep } from "@/lib/engines/live-quarter-checkins";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/lifecycle/live-quarter-checkin-sweep
 *
 * Runs the Live-board quarter check-in engine — creates a "90-day
 * check-in" personal-todo for every eligible customer whose
 * days-until-renewal crosses into Q1/Q2/Q3 today, backed by an
 * idempotent (workspace_id, quarter, renewal_iso) dedupe set so a
 * re-run inside the same day (or a manual retrigger) doesn't
 * double-fire.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} OR any signed-in CSM
 * team member (manual retrigger).
 *
 * Runs daily via .github/workflows/live-quarter-checkins.yml.
 */

async function authorize(req: Request): Promise<"cron" | "manual" | false> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${cronSecret}`) return "cron";
  }
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (email && (await isCsmTeamMember(email))) return "manual";
  return false;
}

export async function POST(req: Request) {
  const triggeredBy = await authorize(req);
  if (!triggeredBy) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun =
    url.searchParams.get("dryRun") === "1" ||
    url.searchParams.get("dryRun") === "true";
  const workspaceIdsParam = url.searchParams.get("workspace_ids");
  const workspaceIds = workspaceIdsParam
    ? workspaceIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    const result = await runLiveQuarterCheckinSweep({ dryRun, workspaceIds });
    console.log("[lifecycle/live-quarter-checkin-sweep]", {
      triggered_by: triggeredBy,
      dry_run: dryRun,
      scanned: result.scanned,
      fired: result.fired.length,
      failures: result.failures.length,
    });
    return NextResponse.json({
      ok: true,
      triggered_by: triggeredBy,
      dry_run: dryRun,
      ...result,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[lifecycle/live-quarter-checkin-sweep] 500", {
      message,
      triggeredBy,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
