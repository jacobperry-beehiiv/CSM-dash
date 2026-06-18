import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  REVIEW_WORKFLOWS,
  type ReviewWorkflow,
} from "@/lib/data/review-states-types";
import { runReviewDigestSweep } from "@/lib/engines/review-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/review-digest/sweep
 *
 * Fires the aggregate per-CSM digest — one Slack message per CSM
 * with non-zero "needs review" counts across past_due / proactive /
 * renewals. See lib/engines/review-digest.ts for eligibility +
 * message shape.
 *
 * Auth: NextAuth session (manual button) OR Authorization: Bearer
 * ${CRON_SECRET} (Phase C cron). Same dual-path the proactive
 * outreach sweep uses.
 *
 * Body (all optional):
 *   { dry_run?: boolean, workflows?: ReviewWorkflow[] }
 *
 * Response:
 *   { ok, dry_run, generated_at, per_csm, messages_sent,
 *     messages_failed, failures, no_channel_configured? }
 */

interface PostBody {
  dry_run?: boolean;
  workflows?: string[];
  /** Optional hand-picked workspace_ids — used by the AM panels'
   *  "Ping N selected on Slack" button to scope the digest to just
   *  the rows the user ticked. Engine still groups by CSM. */
  workspace_ids?: string[];
}

const WORKFLOW_SET: Set<string> = new Set(REVIEW_WORKFLOWS);

async function authorize(
  req: Request
): Promise<"cron" | "manual" | false> {
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

  let body: PostBody = {};
  if (req.headers.get("content-length")) {
    try {
      body = (await req.json()) as PostBody;
    } catch {
      // Tolerate malformed bodies — cron sends none, UI may send {}.
    }
  }
  // Validate + narrow the workflows list, if present.
  let workflows: ReviewWorkflow[] | undefined;
  if (Array.isArray(body.workflows)) {
    workflows = body.workflows.filter(
      (w): w is ReviewWorkflow =>
        typeof w === "string" && WORKFLOW_SET.has(w)
    );
    if (workflows.length === 0) workflows = undefined;
  }

  // Normalize workspace_ids — accept array of strings, ignore everything else.
  const workspaceIds = Array.isArray(body.workspace_ids)
    ? (body.workspace_ids as unknown[]).filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0
      )
    : undefined;

  try {
    const result = await runReviewDigestSweep({
      dryRun: Boolean(body.dry_run),
      triggeredBy,
      workflows,
      workspaceIds,
    });
    return NextResponse.json({
      ok: true,
      triggered_by: triggeredBy,
      ...result,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
