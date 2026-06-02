import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { setProactiveStatus } from "@/lib/data/proactive-outreach";

export const dynamic = "force-dynamic";

/**
 * POST /api/proactive-outreach/status
 *   { workspace_id: string, status: string | null }
 *
 * Manually set the user-facing status on the Proactive Outreach
 * panel — driven by the Status column dropdown a CSM uses to move
 * an account from "Pinged" → "Awaiting response" → "Renewed" etc.
 *
 * Pass `status: null` (or empty string) to clear back to "derive
 * from timestamps" mode. The viewer's session email lands on
 * status_updated_by as an audit trail.
 *
 * Engine-driven status writes (savePingSent → "Pinged",
 * bulkSaveOutreachLogged → "Outreach made") live in those mutators
 * directly — this endpoint is only for manual overrides.
 */

interface PostBody {
  workspace_id?: string;
  status?: string | null;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = (body.workspace_id ?? "").trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  const next = body.status === null ? null : (body.status ?? "").trim() || null;
  try {
    const map = await setProactiveStatus(workspaceId, next, {
      updatedBy: session.user.email,
    });
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
