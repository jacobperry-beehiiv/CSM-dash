import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runEnterpriseRequestsShippedSweep } from "@/lib/engines/enterprise-requests-shipped-sweep";

export const dynamic = "force-dynamic";
// Two Slack channel reads + parse + snapshot write. On a fresh
// cursor the pull can span 500 messages × 2 channels; still fast
// enough that a 120s ceiling has headroom.
export const maxDuration = 120;

/**
 * POST /api/enterprise-requests/shipped-sweep
 *
 * Runs Piece 3 — reads #devs-shipped and #topic-product-changelog,
 * promotes matching snapshot rows to Live / Live-possibly-in-beta,
 * files un-matched hits (past 14 days) to the orphans admin queue.
 *
 * Dual-auth (session OR Bearer CRON_SECRET). Ordered AFTER
 * /api/enterprise-requests/sync in the cron workflow — the sync pulls
 * Linear state first, then this promotes.
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
  try {
    const result = await runEnterpriseRequestsShippedSweep();
    return NextResponse.json({ ...result, triggeredBy });
  } catch (e) {
    console.error("[enterprise-requests/shipped-sweep] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error", ok: false },
      { status: 500 }
    );
  }
}
