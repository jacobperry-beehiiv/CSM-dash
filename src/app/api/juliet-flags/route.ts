import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  loadJulietFlags,
  setJulietFlag,
  setJulietFlagStatus,
  type JulietFlagStatus,
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

/** POST accepts two shapes:
 *   1. Raise/clear:  { workspace_id, flagged, note? }
 *   2. Status change:{ workspace_id, status: "open" | "outreach_made"
 *                                    | "resolved" }
 *  The discriminator is which field is present — `flagged` (boolean)
 *  or `status` (string). A malformed payload with neither returns 400.
 *  Kept as one route to preserve the existing at-risk "Flag for
 *  Juliet" flow without churning callers.
 */
interface PostBody {
  workspace_id: string;
  flagged?: boolean;
  note?: string | null;
  status?: JulietFlagStatus;
}

const VALID_STATUSES: ReadonlySet<JulietFlagStatus> = new Set([
  "open",
  "outreach_made",
  "resolved",
]);

const STATUS_LOG_LABELS: Record<JulietFlagStatus, string> = {
  open: "Juliet flag reopened",
  outreach_made: "Marked Juliet outreach made",
  resolved: "Marked Juliet flag resolved",
};

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

    // Status-change branch. Runs when `status` is provided; ignores
    // `flagged` if both come in on the same payload.
    if (body.status !== undefined) {
      if (!VALID_STATUSES.has(body.status)) {
        return NextResponse.json(
          { error: `Invalid status: ${body.status}` },
          { status: 400 }
        );
      }
      const map = await setJulietFlagStatus(
        body.workspace_id,
        body.status,
        email.toLowerCase()
      );
      try {
        await appendActionLog([
          {
            workspace_id: body.workspace_id,
            text: STATUS_LOG_LABELS[body.status],
            created_by: email.toLowerCase(),
            action_kind: "juliet_flag_status",
            metadata: { status: body.status },
          },
        ]);
      } catch (e) {
        console.warn("[juliet-flags] status action log append failed", e);
      }
      return NextResponse.json(map);
    }

    // Raise/clear branch — original behavior.
    if (typeof body.flagged !== "boolean") {
      return NextResponse.json(
        { error: "Provide either `flagged` (boolean) or `status`." },
        { status: 400 }
      );
    }
    const map = await setJulietFlag(body.workspace_id, body.flagged, {
      flaggedBy: email.toLowerCase(),
      note: body.note ?? null,
    });
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
