import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  resetReminderState,
  runPersonalTodoSweep,
} from "@/lib/personal-todos/reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/personal-todos/sweep
 *
 * Runs the personal-todos sweep: activate scheduled (future-dated)
 * todos when their `surface_at` is due, then fire due-date reminders
 * across the 4-stage ladder. Same dual-auth pattern as the team-tasks
 * sweep:
 *
 *   - Bearer ${CRON_SECRET} (GitHub Actions cron)
 *   - OR a signed-in NextAuth session (admin "Run now" button)
 *
 * Query params:
 *   ?dryRun=1  — simulate; don't DM, don't flip surface_at, don't
 *                persist the dedupe state. Returns the would-fire
 *                counts so an admin can sanity-check before going live.
 *   ?reset=1   — clear the dedupe state before running. Useful after
 *                test runs left rows that need re-pinging for real.
 */
export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const reset = url.searchParams.get("reset") === "1";
  try {
    let cleared: number | null = null;
    if (reset) {
      const r = await resetReminderState();
      cleared = r.cleared;
    }
    const result = await runPersonalTodoSweep({ dryRun });
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
