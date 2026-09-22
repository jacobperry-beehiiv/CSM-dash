import { NextResponse } from "next/server";
import { after } from "next/server";
import { runAssignSideEffects } from "@/lib/integrations/slack-assign";
import type { ViewSubmissionPayload } from "@/lib/integrations/slack-views";

/**
 * POST /api/slack-webhook/assign-process
 *
 * Background side-effects endpoint for the @bot assign modal. The
 * primary webhook (/api/slack-webhook) validates the form
 * synchronously, closes the modal within Slack's 3-second ACK
 * window, and fires this endpoint asynchronously. That side-steps the
 * old failure mode where the whole assign flow — HubSpot PATCH +
 * deal→company transpose + ~30 to-do writes + Drive folder copy with
 * template seed (~500ms × N files) + HubSpot property write for the
 * folder URL + thread reply + DM — ran synchronously and blew through
 * Vercel's 15s serverless timeout mid-Drive-copy.
 *
 * Why a separate endpoint (rather than `after()` on the webhook
 * itself): the webhook route is a general-purpose surface — DMs,
 * reactions, mentions, slash commands, other view submissions, block
 * actions — and bumping ITS maxDuration to 60 to accommodate the
 * assign flow would keep every other invocation on the same wide
 * budget. Splitting it out also gives the assign flow its own
 * Vercel log line, its own retry story, and its own alerting hook.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` — same shared secret
 * every other internal/cron endpoint in this repo uses. The primary
 * webhook route verifies the Slack HMAC before dispatching, so this
 * endpoint is not reachable from outside the deployment.
 *
 * ACK strategy: use `after()` to schedule the actual work and return
 * `{ ok: true }` immediately. That way the caller's `await fetch()`
 * resolves in ~100ms and the webhook route returns to Slack fast,
 * while this endpoint keeps running under its own 60s budget.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { payload?: ViewSubmissionPayload } = {};
  try {
    body = (await req.json()) as { payload?: ViewSubmissionPayload };
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON body" },
      { status: 400 }
    );
  }
  const payload = body.payload;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json(
      { error: "Missing `payload` in body" },
      { status: 400 }
    );
  }

  // Schedule the real work after the response is sent. Vercel's
  // maxDuration covers response + after() together, so we get the
  // full 60s for the assign flow.
  after(async () => {
    try {
      await runAssignSideEffects(payload);
    } catch (e) {
      console.error(
        "[assign-process] runAssignSideEffects threw",
        e instanceof Error ? e.stack ?? e.message : e
      );
    }
  });

  return NextResponse.json({ ok: true });
}
