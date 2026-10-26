import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { appendActionLog } from "@/lib/data/customer-signals";
import {
  addChildWorkspace,
  findExistingParent,
  getChildWorkspaces,
  removeChildWorkspace,
  type ChildWorkspaceLink,
} from "@/lib/data/child-workspaces";
import {
  fetchChildWorkspaceMetrics,
  type ChildWorkspaceMetrics,
} from "@/lib/data/child-workspace-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Child workspaces for one parent account.
 *
 * GET    → { children: [{ ...link, metrics }] }
 * POST   → link a child.   Body: { workspace_id, workspace_name?, note? }
 * DELETE → unlink a child. Query: ?child=<workspace_id>
 *
 * Why metrics are fetched here rather than folded into loadCustomers:
 * the ClickHouse subscriber count runs ~8s for a handful of ids, which
 * is fine for a lazily-mounted section and emphatically not fine on
 * the critical path of every profile render. The client island calls
 * this on mount, same posture as the News and Requests sections.
 *
 * Auth: signed-in viewer + the `child-workspaces` flag. GET is gated
 * too — unlike most reads here — because the whole point of a link is
 * to surface a workspace that is deliberately absent from the book,
 * and that shouldn't leak to viewers who don't have the feature.
 */

async function gate(): Promise<
  { ok: true; email: string } | { ok: false; res: NextResponse }
> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Sign in required" }, { status: 401 }),
    };
  }
  if (!(await isFeatureEnabledFor("child-workspaces", email))) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Feature not available for this account" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, email };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ workspace_id: string }> }
) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { workspace_id: parentId } = await params;
  try {
    const links = await getChildWorkspaces(parentId);
    let metrics = new Map<string, ChildWorkspaceMetrics>();
    if (links.length > 0) {
      try {
        metrics = await fetchChildWorkspaceMetrics(
          links.map((l) => l.workspace_id)
        );
      } catch (e) {
        // Metrics are enrichment. A ClickHouse hiccup shouldn't hide
        // the fact that links exist — render the rows without numbers
        // rather than an empty section that reads as "no children".
        console.error("[children GET] metrics fetch failed", e);
      }
    }
    return NextResponse.json({
      children: links.map((l) => ({
        ...l,
        metrics: metrics.get(l.workspace_id) ?? null,
      })),
    });
  } catch (e) {
    console.error("[children GET] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load children" },
      { status: 500 }
    );
  }
}

interface PostBody {
  workspace_id?: string;
  workspace_name?: string | null;
  note?: string | null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workspace_id: string }> }
) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { workspace_id: parentId } = await params;
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const childId = (body.workspace_id ?? "").trim();
  if (!childId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  // Caught here rather than letting the store throw into the 500
  // handler — it's a bad request, not a server fault, and the
  // distinction matters to anyone reading logs.
  if (childId === parentId) {
    return NextResponse.json(
      { error: "A workspace can't be its own child." },
      { status: 400 }
    );
  }
  try {
    // One workspace, one parent. Two accounts both claiming the same
    // child would show identical subscriber numbers under two
    // customers, which is a data-entry mistake rather than a real
    // relationship — so refuse and name the existing parent.
    const existing = await findExistingParent(childId);
    if (existing && existing !== parentId) {
      return NextResponse.json(
        {
          error: `That workspace is already linked as a child of ${existing}. Unlink it there first.`,
          existing_parent: existing,
        },
        { status: 409 }
      );
    }
    const link: ChildWorkspaceLink = {
      workspace_id: childId,
      workspace_name: body.workspace_name?.trim() || null,
      note: body.note?.trim() || null,
      linked_by: g.email.toLowerCase(),
      linked_at: new Date().toISOString(),
    };
    const children = await addChildWorkspace(parentId, link);
    try {
      await appendActionLog([
        {
          workspace_id: parentId,
          text: `Linked child workspace: ${link.workspace_name ?? childId}`,
          created_by: g.email.toLowerCase(),
          action_kind: "child_workspace_linked",
          metadata: { child_workspace_id: childId },
        },
      ]);
    } catch (e) {
      // Paper trail is nice-to-have; the link already landed.
      console.warn("[children POST] action log failed", e);
    }
    return NextResponse.json({ ok: true, children });
  } catch (e) {
    console.error("[children POST] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to link child" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ workspace_id: string }> }
) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { workspace_id: parentId } = await params;
  const childId = (new URL(req.url).searchParams.get("child") ?? "").trim();
  if (!childId) {
    return NextResponse.json(
      { error: "?child=<workspace_id> is required" },
      { status: 400 }
    );
  }
  try {
    const children = await removeChildWorkspace(parentId, childId);
    try {
      await appendActionLog([
        {
          workspace_id: parentId,
          text: `Unlinked child workspace ${childId}`,
          created_by: g.email.toLowerCase(),
          action_kind: "child_workspace_unlinked",
          metadata: { child_workspace_id: childId },
        },
      ]);
    } catch (e) {
      console.warn("[children DELETE] action log failed", e);
    }
    return NextResponse.json({ ok: true, children });
  } catch (e) {
    console.error("[children DELETE] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to unlink child" },
      { status: 500 }
    );
  }
}
