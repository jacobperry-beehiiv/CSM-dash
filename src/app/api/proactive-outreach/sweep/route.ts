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
  const auth_result = await authorize(req);
  if (!auth_result) {
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
      // Auth path drives the gate: Bearer-secret = cron, session =
      // manual. The settings toggle only mutes cron runs so an admin
      // can still ping on-demand from the panel button.
      triggeredBy: auth_result === "cron" ? "cron" : "manual",
    });
    // Disabled-by-settings is a non-error 200 — the cron should see
    // this as a deliberate skip, not a failure. ok stays true.
    if (result.disabled) {
      return NextResponse.json({
        ok: true,
        disabled: true,
        reason: result.reason,
        triggered_by: auth_result,
        ...result,
      });
    }
    return NextResponse.json({
      ok: true,
      dryRun,
      triggered_by: auth_result,
      scope: workspaceIds ? { count: workspaceIds.length } : null,
      ...result,
    });
  } catch (e) {
    // Surface the full stack to Vercel logs so we can debug 500s
    // without round-tripping through the user. The response body
    // stays sanitized (message only) to avoid leaking internals to
    // the browser.
    const message = e instanceof Error ? e.message : "Unknown error";
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[proactive-outreach/sweep] 500", {
      message,
      stack,
      workspace_ids_count: workspaceIds?.length ?? 0,
      dry_run: dryRun,
      triggered_by: auth_result,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Returns the auth path that succeeded, or false on rejection. We
 *  branch on the result downstream so the schedule-disabled toggle
 *  can apply to cron runs only. */
async function authorize(req: Request): Promise<"cron" | "manual" | false> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${cronSecret}`) return "cron";
  }
  const session = await auth();
  return session?.user?.email ? "manual" : false;
}
