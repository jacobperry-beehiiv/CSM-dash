import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  loadJulietFlags,
  setJulietFlag,
} from "@/lib/data/juliet-flags-store";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * GET  /api/juliet-flags       — full { workspace_id → JulietFlag } map.
 * POST /api/juliet-flags       — set/clear a workspace's flag.
 *   body: { workspace_id, flagged: boolean, note?: string }
 *
 * Auth: signed-in session. `flagged_by` is stamped server-side from the
 * session so the client can't forge a raiser email. Any CSM can toggle
 * any workspace — this is a shared team escalation queue.
 */

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }
    const map = await loadJulietFlags();
    return NextResponse.json(map);
  } catch (error) {
    console.error("[juliet-flags] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface PostBody {
  workspace_id: string;
  flagged: boolean;
  note?: string | null;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const email = session?.user?.email ?? null;
    if (!email) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }
    const body = (await req.json()) as PostBody;
    if (!body.workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    const map = await setJulietFlag(body.workspace_id, Boolean(body.flagged), {
      flaggedBy: email.toLowerCase(),
      note: body.note ?? null,
    });
    // Log to the customer signals stream so a scroll through the
    // account's history shows "flagged for Juliet by X" — same
    // pattern as flag-resolution POSTs. Non-blocking; failure
    // shouldn't reject the flag mutation.
    try {
      await appendActionLog([
        {
          workspace_id: body.workspace_id,
          text: body.flagged
            ? `Flagged for Juliet outreach${body.note ? `: ${body.note}` : ""}`
            : "Cleared Juliet outreach flag",
          created_by: email.toLowerCase(),
          action_kind: "juliet_flag",
          metadata: { flagged: Boolean(body.flagged) },
        },
      ]);
    } catch (e) {
      console.warn("[juliet-flags] action log append failed", e);
    }
    return NextResponse.json(map);
  } catch (error) {
    console.error("[juliet-flags] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
