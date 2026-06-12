import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runDeliverabilitySlackSweep } from "@/lib/engines/deliverability-slack";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/deliverability/sweep
 *
 * Posts Slack pings for newly-seen critical deliverability posts.
 * Idempotent per post_id (KV dedupe). Respects notification prefs at
 * /settings/slack.
 *
 * Auth: NextAuth session OR Authorization: Bearer ${CRON_SECRET}.
 * Query: `?dryRun=1` previews without posting.
 */

async function authorize(req: Request): Promise<"cron" | "manual" | false> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${cronSecret}`) return "cron";
  }
  const session = await auth();
  return session?.user?.email ? "manual" : false;
}

export async function POST(req: Request) {
  const triggeredBy = await authorize(req);
  if (!triggeredBy) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    const result = await runDeliverabilitySlackSweep({
      dryRun,
      triggeredBy,
    });
    return NextResponse.json({
      ok: true,
      triggered_by: triggeredBy,
      ...result,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[deliverability/sweep] 500", { message, triggeredBy, dryRun });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
