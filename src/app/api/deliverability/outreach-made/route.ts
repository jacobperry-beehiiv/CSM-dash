import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { clearPost } from "@/lib/data/deliverability-clears";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * POST /api/deliverability/outreach-made
 *
 * Body:
 *   {
 *     post_id: string,          // required — hides the alert from the panel
 *     workspace_id: string,     // required — target for the action_log note
 *     subject?: string,         // send subject (best-effort context)
 *     newsletter?: string,      // publication name
 *     flag_summary?: string,    // short list of the flags that triggered it
 *     note?: string             // CSM-typed "what was the outreach about"
 *   }
 *
 * Two side effects, sequenced:
 *   1. Persist a "cleared" resolution for `post_id` (same shape as the
 *      Clear button) so the alert falls off the deliverability panel.
 *      The clear's `reason` field is a compact summary the CSM will
 *      see when they toggle "Show cleared".
 *   2. Append an action_log note on the customer's signals stream so
 *      the profile Notes surface shows what outreach was made and why.
 *      The `text` is preformatted with the send subject + flag summary
 *      + the CSM's note so a scroll through Notes reads standalone.
 *
 * The clear is the load-bearing side effect — if the action_log append
 * fails we still return ok. A best-effort log failure shouldn't strand
 * the row on the panel; the CSM would re-hit the button and get a
 * duplicate clear (idempotent).
 *
 * Auth: signed-in session. Any CSM can mark any post — this is a
 * shared workflow, same posture as the existing Clear button.
 */

interface Body {
  post_id?: string;
  workspace_id?: string;
  subject?: string;
  newsletter?: string;
  flag_summary?: string;
  note?: string;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const email = session?.user?.email ?? null;
    if (!email) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const postId = (body.post_id ?? "").trim();
    const workspaceId = (body.workspace_id ?? "").trim();
    if (!postId) {
      return NextResponse.json(
        { error: "post_id is required." },
        { status: 400 }
      );
    }
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace_id is required." },
        { status: 400 }
      );
    }

    const subject = body.subject?.trim() || null;
    const newsletter = body.newsletter?.trim() || null;
    const flagSummary = body.flag_summary?.trim() || null;
    const csmNote = body.note?.trim() || null;

    // Preformat the note text so the Notes surface reads standalone.
    // Prefer the CSM's typed context; fall back to the flag summary
    // when they hit the button without adding a note ("outreach made"
    // is still a useful signal even without free-text).
    const contextLine = [newsletter, subject ? `“${subject}”` : null]
      .filter(Boolean)
      .join(" — ");
    const bodyLine = csmNote ?? flagSummary ?? "no additional context";
    const noteText =
      `Deliverability outreach made${contextLine ? ` (${contextLine})` : ""}: ${bodyLine}`;

    // Clear = load-bearing. If it throws, surface the error; the CSM
    // will retry, no partial state on the panel.
    await clearPost(postId, {
      clearedBy: email,
      reason: csmNote ? `Outreach made: ${csmNote}` : "Outreach made",
    });

    // Action log = best-effort. A KV blip here shouldn't strand the
    // clear; we swallow the error but surface it in the response so
    // the client can toast "cleared but note failed" if it wants.
    let logOk = true;
    let logError: string | null = null;
    try {
      await appendActionLog([
        {
          workspace_id: workspaceId,
          text: noteText,
          created_by: email.toLowerCase(),
          action_kind: "deliverability_outreach_made",
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
      console.warn("[deliverability/outreach-made] action log append failed", e);
    }

    return NextResponse.json({ ok: true, log_ok: logOk, log_error: logError });
  } catch (error) {
    console.error("[deliverability/outreach-made] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
