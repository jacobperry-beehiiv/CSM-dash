import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { clearTrend, unclearTrend } from "@/lib/data/trend-clears";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * POST   /api/engagement-trends/clear
 *   Body: { workspace_id, severity, summary? }
 *   → silences the red row for that workspace. `severity` is stamped
 *     into the clear so the engine can re-raise when the decline gets
 *     materially worse (see lib/data/trend-clears.ts).
 *
 * DELETE /api/engagement-trends/clear  { workspace_id }
 *   → un-silences it.
 *
 * Auth: signed-in session only; `cleared_by` is stamped with the
 * viewer's email so other CSMs can see who acknowledged it.
 */

interface Body {
  workspace_id?: string;
  severity?: number;
  summary?: string;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    const workspaceId = body.workspace_id;
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    // Severity has to come from the caller because the clear is
    // relative to what was on screen when they dismissed it. Defaulting
    // to 0 on a missing value would make the row re-raise immediately,
    // so treat it as a bad request instead.
    if (typeof body.severity !== "number") {
      return NextResponse.json(
        { error: "severity is required (number)" },
        { status: 400 }
      );
    }

    const map = await clearTrend(workspaceId, body.severity, {
      clearedBy: email,
    });

    // Same pattern as the deliverability clear: leave a trace on the
    // customer's own signal stream so the acknowledgement is visible
    // from the profile, not just from this table.
    if (body.summary) {
      try {
        await appendActionLog([
          {
            workspace_id: workspaceId,
            text: `Engagement trend acknowledged: ${body.summary}`,
            created_by: email,
            action_kind: "trend_cleared",
          },
        ]);
      } catch (e) {
        // A failed note shouldn't fail the dismissal — the clear is
        // the user-visible action and it has already been written.
        console.error("[engagement-trends] action log failed:", e);
      }
    }

    return NextResponse.json({ ok: true, clears: map });
  } catch (e) {
    console.error("[engagement-trends] clear POST failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = (await req.json()) as Body;
    if (!body.workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    const map = await unclearTrend(body.workspace_id);
    return NextResponse.json({ ok: true, clears: map });
  } catch (e) {
    console.error("[engagement-trends] clear DELETE failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
