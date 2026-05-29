import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { reconcilePastDueHistory } from "@/lib/data/past-due-history";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/past-due/history/sweep
 *
 * Reconciles the historical episode map against the current q24620
 * snapshot. Opens episodes for new arrivals, closes them when a
 * customer drops out of q24620 (presumed paid), and bumps running
 * counters on active ones.
 *
 * Auth: dual-path — Bearer ${CRON_SECRET} for the daily GH Actions
 * cron OR a signed-in NextAuth session for an admin "Refresh
 * history" button.
 */
export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await reconcilePastDueHistory();
    return NextResponse.json({ ok: true, ...result });
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
