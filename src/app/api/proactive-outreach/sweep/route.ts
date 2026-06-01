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
 * Query: `?dryRun=1` counts what WOULD fire without posting to Slack.
 *
 * Body (optional): `{ workspace_ids?: string[] }` — when present,
 * scopes the sweep to that subset. The AM-tab "Ping selected" button
 * uses this; the cron sends no body and gets the full cohort.
 */
interface PostBody {
  workspace_ids?: string[];
}

export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  // Body is optional — the cron POSTs with no body, the UI sometimes
  // posts JSON with workspace_ids. Don't reject on missing body.
  let body: PostBody = {};
  if (req.headers.get("content-length")) {
    try {
      body = (await req.json()) as PostBody;
    } catch {
      // Tolerate malformed bodies — fall back to full-cohort sweep.
    }
  }
  const workspaceIds = Array.isArray(body.workspace_ids)
    ? body.workspace_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;

  try {
    const result = await runProactiveOutreachSweep({
      dryRun,
      workspaceIds,
    });
    return NextResponse.json({
      ok: true,
      dryRun,
      scope: workspaceIds ? { count: workspaceIds.length } : null,
      ...result,
    });
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
