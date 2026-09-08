import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runEnterpriseRequestsSync } from "@/lib/engines/enterprise-requests-sync";

export const dynamic = "force-dynamic";
// Linear GraphQL pagination + customer-book load is fast (<20s in
// practice for a book of ~600 issues). Keep the cap generous so a
// pagination spike or a slow book-load doesn't kill an in-progress
// sync mid-flight — matches the news-sweep 240s ceiling.
export const maxDuration = 240;

/**
 * POST /api/enterprise-requests/sync
 *
 * Runs the nightly Linear pull → snapshot write. Dual-auth: cron via
 * `Authorization: Bearer ${CRON_SECRET}`, manual via signed-in
 * session. Same pattern as `/api/news/sweep`.
 *
 * No body params in v1 — the sync always pulls the full "issues with
 * customer_needs" set. A future `?since` filter could narrow the
 * pull, but Linear's `filter` clause on `customerNeeds.some` already
 * scopes tightly enough that a full-set pull is well under maxDuration.
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
    const result = await runEnterpriseRequestsSync();
    return NextResponse.json({ ...result, triggeredBy });
  } catch (e) {
    console.error("[enterprise-requests/sync] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error", ok: false },
      { status: 500 }
    );
  }
}
