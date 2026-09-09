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
 * Dual-auth (session OR `Bearer CRON_SECRET`) — same shape as the
 * sync + shipped-sweep endpoints. Runs in the nightly cron right
 * after those.
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
  try {
    const result = await runSlackIntakeSweep();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "sweep failed" },
      { status: 500 }
    );
  }
}
