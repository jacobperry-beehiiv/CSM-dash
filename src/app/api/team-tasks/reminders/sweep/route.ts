import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  runReminderSweep,
  resetReminderState,
} from "@/lib/team-tasks/reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/team-tasks/reminders/sweep
 *
 * Runs the due-date reminder sweep. Each invocation:
 *   - Loads open-asks + roster
 *   - Identifies tasks at THREE_DAYS_OUT / ONE_DAY_OUT / DUE_TODAY /
 *     THREE_DAYS_OVERDUE stages
 *   - DMs members with `slack_user_id` set and assignment === "unchecked"
 *   - Tracks fired (task, member, stage) tuples in KV so reruns don't
 *     double-ping
 *
 * Auth: accepts either
 *   • A signed-in NextAuth session (admin clicking "Send reminders now"
 *     on /settings/team), OR
 *   • Authorization: Bearer ${CRON_SECRET} (GitHub Actions daily cron)
 *
 * Pass `?dryRun=1` to skip the actual Slack call but still report what
 * would have been sent — useful for verifying mapping before the first
 * live run.
 */
export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const reset = url.searchParams.get("reset") === "1";
  try {
    // `?reset=1` clears the dedupe state before running so anyone
    // eligible right now will be re-pinged. Useful after test runs.
    // Default behavior is unchanged — the cron call never passes this.
    let cleared: number | null = null;
    if (reset) {
      const r = await resetReminderState();
      cleared = r.cleared;
    }
    const result = await runReminderSweep({ dryRun });
    return NextResponse.json({
      ok: true,
      dryRun,
      reset,
      cleared,
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
