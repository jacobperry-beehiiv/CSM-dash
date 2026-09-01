import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  clearPost,
  unclearPost,
} from "@/lib/data/deliverability-clears";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * POST   /api/deliverability/clear
 *   Body: {
 *     post_id: string,
 *     workspace_id?: string,     // when present → append action_log note
 *     subject?: string,          // send subject for the note context line
 *     newsletter?: string,       // publication name for the note context
 *     flag_summary?: string,     // human-readable flag summary
 *   }
 *
 *   → records a "clear" resolution for that send. Future runs of the
 *     deliverability engine attach the clear to the alert so the panel
 *     can hide it by default (or show it with the "Cleared" pill when
 *     the "Show cleared" toggle is on).
 *
 *   → if the enrichment fields are present, also appends an action_log
 *     note on the customer's signals stream so the profile Notes surface
 *     shows what flags were on the alert when it was acknowledged. This
 *     replaces the old free-text "reason" prompt with an auto-generated
 *     summary — CSMs no longer type anything to clear, but the flag
 *     context still lands on the customer profile.
 *
 * DELETE /api/deliverability/clear  { post_id }
 *   → un-clears (admin pressed "undo" on a previously cleared row).
 *
 * Auth: signed-in session only. The `cleared_by` field gets stamped
 * with the viewer's email so other CSMs can see who handled it.
 */

interface Body {
  post_id?: string;
  workspace_id?: string;
  subject?: string;
  newsletter?: string;
  flag_summary?: string;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const postId = (body.post_id ?? "").trim();
  if (!postId) {
    return NextResponse.json(
      { error: "post_id is required." },
      { status: 400 }
    );
  }
  const workspaceId = (body.workspace_id ?? "").trim();
  const subject = body.subject?.trim() || null;
  const newsletter = body.newsletter?.trim() || null;
  const flagSummary = body.flag_summary?.trim() || null;

  // The clear's `reason` field is the compact summary shown when the
  // CSM toggles "Show cleared". Auto-generated from the flag summary
  // so admins see why the alert was acknowledged without a free-text
  // step. When we don't have a flag summary (rare — unmapped alert),
  // fall through to a generic marker.
  const reason = flagSummary ? `Cleared: ${flagSummary}` : "Cleared";
  await clearPost(postId, { clearedBy: session.user.email, reason });

  // Action log = best-effort, and only when we have both the
  // workspace_id (target) and a flag summary (payload). A KV blip
  // here shouldn't roll back the clear; the alert is already off the
  // panel and the CSM would re-hit the button and get a duplicate
  // clear (idempotent). Same posture as /outreach-made.
  let logOk = true;
  let logError: string | null = null;
  if (workspaceId && flagSummary) {
    const contextLine = [newsletter, subject ? `“${subject}”` : null]
      .filter(Boolean)
      .join(" — ");
    const noteText =
      `Deliverability alert cleared${contextLine ? ` (${contextLine})` : ""}: ${flagSummary}`;
    try {
      await appendActionLog([
        {
          workspace_id: workspaceId,
          text: noteText,
          created_by: session.user.email.toLowerCase(),
          action_kind: "deliverability_cleared",
          metadata: {
            post_id: postId,
            subject,
            newsletter,
            flag_summary: flagSummary,
          },
        },
      ]);
    } catch (e) {
      logOk = false;
      logError = e instanceof Error ? e.message : "Unknown error";
      console.warn("[deliverability/clear] action log append failed", e);
    }
  }

  return NextResponse.json({ ok: true, log_ok: logOk, log_error: logError });
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const postId = (body.post_id ?? "").trim();
  if (!postId) {
    return NextResponse.json(
      { error: "post_id is required." },
      { status: 400 }
    );
  }
  await unclearPost(postId);
  return NextResponse.json({ ok: true });
}
