import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runNewsSweep } from "@/lib/engines/news-sweep";

export const dynamic = "force-dynamic";
// 150 customers × ~3 RSS fetches × ~1-2s each, run 5 concurrent ⇒
// ~60-120s typical. Bump maxDuration to 240 for headroom against
// Google's occasional 3-4s latency spikes.
export const maxDuration = 240;

/**
 * POST /api/news/sweep
 *
 * Walks the customer book, fetches Google News headlines per
 * workspace, writes the result to KV. The dashboard's homepage
 * BookNewsPanel reads exclusively from this cache.
 *
 * Auth: dual session/bearer (matches proactive-outreach + review-
 * digest sweep routes). Cron path = Bearer ${CRON_SECRET}; manual
 * path = signed-in session.
 *
 * Query: `?dryRun=1` counts what would be processed without
 * touching Google or the cache.
 *
 * Body (optional): `{ workspace_ids?: string[] }` — scope the sweep
 * to a subset. Useful for testing or for back-filling specific
 * customers without running the whole sweep.
 */

interface PostBody {
  workspace_ids?: string[];
}

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
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  let body: PostBody = {};
  if (req.headers.get("content-length")) {
    try {
      body = (await req.json()) as PostBody;
    } catch {
      // Tolerate malformed bodies — cron sends none; UI may send {}.
    }
  }
  const workspaceIds = Array.isArray(body.workspace_ids)
    ? body.workspace_ids.filter(
        (id): id is string => typeof id === "string" && id.length > 0
      )
    : undefined;

  try {
    const result = await runNewsSweep({
      dryRun,
      triggeredBy,
      workspaceIds,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[news/sweep] 500", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
