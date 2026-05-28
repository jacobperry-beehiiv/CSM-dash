import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  bulkSaveOutreachLogged,
  loadProactiveOutreach,
  saveOutreachLogged,
  clearProactiveEntry,
} from "@/lib/data/proactive-outreach";

export const dynamic = "force-dynamic";

/**
 * GET    /api/proactive-outreach
 *   → current outreach-state map keyed by workspace_id.
 *
 * POST   /api/proactive-outreach
 *   { workspace_id, note? }
 *   → marks outreach as logged for a single workspace. Stamps
 *     last_outreach_at + last_outreach_by from the session.
 *
 * PUT    /api/proactive-outreach
 *   { workspace_ids: [...], note? }
 *   → bulk-mark; used after a bulk-draft action.
 *
 * DELETE /api/proactive-outreach
 *   { workspace_id }
 *   → clears the lifecycle row (admin reset).
 */

interface SingleBody {
  workspace_id?: string;
  note?: string;
}

interface BulkBody {
  workspace_ids?: string[];
  note?: string;
}

export async function GET() {
  try {
    const map = await loadProactiveOutreach();
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: SingleBody;
  try {
    body = (await req.json()) as SingleBody;
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
  const map = await saveOutreachLogged(workspaceId, {
    loggedBy: session.user.email,
    note: body.note ?? null,
  });
  return NextResponse.json(map);
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.workspace_ids) || body.workspace_ids.length === 0) {
    return NextResponse.json(
      { error: "workspace_ids must be a non-empty array" },
      { status: 400 }
    );
  }
  const map = await bulkSaveOutreachLogged(body.workspace_ids, {
    loggedBy: session.user.email,
    note: body.note ?? null,
  });
  return NextResponse.json(map);
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: SingleBody;
  try {
    body = (await req.json()) as SingleBody;
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
  const map = await clearProactiveEntry(workspaceId);
  return NextResponse.json(map);
}
