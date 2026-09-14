import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runLinearCommentScan } from "@/lib/engines/enterprise-requests-linear-comment-scan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/enterprise-requests/linear-comment-scan
 *
 * Walks open Linear issues (statusType NOT completed/canceled) and
 * scans each ticket's comments for structured customer-request
 * signals (`Publication ID` / `User Email` / mailto). Annotates
 * existing snapshot rows with a permalink back to the matching
 * comment, or injects a new row when the ticket wasn't already
 * covered by the customer_needs sync.
 *
 * Query params:
 *   • `backfill=1` — ignore the stored cursor and walk every open
 *     issue (up to ~5000). Use once after the initial rollout so
 *     historic comments get processed.
 *
 * Dual-auth (session OR `Bearer CRON_SECRET`). Wired into the
 * nightly enterprise-requests-sync workflow after the customer_needs
 * sync + shipped-sweep steps.
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
    const result = await runLinearCommentScan({ backfill });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "scan failed" },
      { status: 500 }
    );
  }
}
