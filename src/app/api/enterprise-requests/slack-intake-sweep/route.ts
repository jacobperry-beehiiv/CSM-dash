import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runSlackIntakeSweep } from "@/lib/engines/enterprise-requests-slack-intake-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * POST /api/enterprise-requests/slack-intake-sweep
 *
 * Walks #enterprise-bugs-and-feature-requests, matches messages to
 * (workspace_id, Linear ticket) pairs, and either annotates existing
 * snapshot rows with a Slack permalink or injects a new row (with a
 * per-message Linear API lookup) when the Linear sync hadn't
 * captured it yet.
 *
 * Query params:
 *   • `backfill=1` — ignore the stored cursor and walk the entire
 *     visible channel history (up to ~5000 messages). Use after a
 *     parser bug fix or the first-time bootstrap so historic posts
 *     get re-processed. The cursor still advances to the newest ts
 *     seen, so a subsequent incremental run resumes correctly.
 *
 * Dual-auth (session OR `Bearer CRON_SECRET`) — same shape as the
 * sync + shipped-sweep endpoints. Runs in the nightly cron right
 * after those (incremental mode; backfill is manual-only).
 */

async function isAuthed(req: Request): Promise<boolean> {
  const session = await auth();
  if (session?.user?.email) return true;
  const cron = process.env.CRON_SECRET;
  if (!cron) return false;
  return req.headers.get("authorization") === `Bearer ${cron}`;
}

export async function POST(req: Request) {
  if (!(await isAuthed(req))) {
    return NextResponse.json(
      { error: "Sign in or Bearer CRON_SECRET required." },
      { status: 401 }
    );
  }
  const url = new URL(req.url);
  const backfill = url.searchParams.get("backfill") === "1";
  try {
    const result = await runSlackIntakeSweep({ backfill });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "sweep failed" },
      { status: 500 }
    );
  }
}
