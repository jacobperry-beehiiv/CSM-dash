import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  dismissHeadline,
  loadDismissedNews,
  undismissHeadline,
  dismissalsForWorkspace,
} from "@/lib/data/news-dismissals";

export const dynamic = "force-dynamic";

/**
 * Per-(workspace, URL) news headline dismissals.
 *
 * GET    /api/news/dismissals?workspace_id=<id>
 *   → list of dismissals for the workspace (used by the per-customer
 *     panel's "Show hidden" toggle to surface restore candidates).
 *
 * POST   /api/news/dismissals
 *   { workspace_id, url, title? }
 *   → mark the headline as not-relevant for that workspace. Idempotent
 *     (re-posting the same key bumps the dismissed_at timestamp).
 *
 * DELETE /api/news/dismissals
 *   { workspace_id, url }
 *   → restore the headline.
 *
 * Auth: signed-in session only. Dismissals are global (every CSM
 * benefits when one of them flags a story as off-topic for a customer).
 */

interface DismissBody {
  workspace_id?: string;
  url?: string;
  title?: string | null;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspace_id") ?? "").trim();
  const all = await loadDismissedNews();
  if (workspaceId) {
    return NextResponse.json({
      dismissals: dismissalsForWorkspace(all, workspaceId),
    });
  }
  return NextResponse.json({ dismissals: Object.values(all) });
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: DismissBody;
  try {
    body = (await req.json()) as DismissBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = body.workspace_id?.trim();
  const url = body.url?.trim();
  if (!workspaceId || !url) {
    return NextResponse.json(
      { error: "workspace_id and url are required" },
      { status: 400 }
    );
  }
  await dismissHeadline(workspaceId, url, {
    title: body.title ?? null,
    dismissedBy: email,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: DismissBody;
  try {
    body = (await req.json()) as DismissBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = body.workspace_id?.trim();
  const url = body.url?.trim();
  if (!workspaceId || !url) {
    return NextResponse.json(
      { error: "workspace_id and url are required" },
      { status: 400 }
    );
  }
  await undismissHeadline(workspaceId, url);
  return NextResponse.json({ ok: true });
}
