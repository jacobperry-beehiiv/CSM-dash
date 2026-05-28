import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runProactiveOutreachSweep } from "@/lib/engines/proactive-outreach";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/proactive-outreach/sweep
 *
 * Scans the Enterprise cohort, fires Slack pings for newly-crossing
 * accounts, and nudges AM after 5 days of no logged outreach.
 *
 * Auth — accepts EITHER:
 *   • A signed-in NextAuth session (admin clicking "Sweep now")
 *   • Authorization: Bearer ${CRON_SECRET} (GitHub Actions daily cron)
 *
 * `?dryRun=1` counts what WOULD fire without posting to Slack.
 */
export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  try {
    const result = await runProactiveOutreachSweep({ dryRun });
    return NextResponse.json({ ok: true, dryRun, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

async function authorize(req: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${cronSecret}`) return true;
  }
  const session = await auth();
  return Boolean(session?.user?.email);
}
