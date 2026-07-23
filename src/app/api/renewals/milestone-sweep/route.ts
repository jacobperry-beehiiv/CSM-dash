import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import { runRenewalMilestoneSweep } from "@/lib/engines/renewal-milestones";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/renewals/milestone-sweep
 *
 * Runs the CSM-owned renewals milestone engine — fires 90 / 60 / 30 /
 * 7 day pings + personal-todos for every eligible customer, backed by
 * an idempotent (workspace_id, milestone_days, renewal_iso) dedupe
 * set so a re-run inside the same day (or a manual retrigger)
 * doesn't double-fire.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} OR any signed-in CSM
 * team member (manual "Sweep now" from a future admin surface).
 *
 * Runs daily via .github/workflows/renewal-milestones.yml (15:00 UTC,
 * 30 minutes after personal-todos activation so a fresh 90d todo has
 * time to land before that day's reminder sweep).
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
    const result = await runRenewalMilestoneSweep({
      dryRun,
      workspaceIds,
    });
    console.log("[renewals/milestone-sweep]", {
      triggered_by: triggeredBy,
      dry_run: dryRun,
      scanned: result.scanned,
      fired: result.fired.length,
      failures: result.failures.length,
      disabled: result.disabled ?? false,
    });
    return NextResponse.json({
      ok: true,
      triggered_by: triggeredBy,
      dry_run: dryRun,
      ...result,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[renewals/milestone-sweep] 500", {
      message,
      triggeredBy,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
