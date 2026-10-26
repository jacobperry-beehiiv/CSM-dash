import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { appendActionLog } from "@/lib/data/customer-signals";
import {
  addManagedWorkspace,
  findExistingParent,
  getManagedWorkspaces,
  removeManagedWorkspace,
  type ManagedWorkspaceLink,
} from "@/lib/data/managed-workspaces";
import {
  fetchManagedWorkspaceMetrics,
  type ManagedWorkspaceMetrics,
} from "@/lib/data/managed-workspace-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Managed workspaces for one parent account.
 *
 * GET    → { managed: [{ ...link, metrics }] }
 * POST   → link a workspace.   Body: { workspace_id, workspace_name?, note? }
 * DELETE → unlink one.      Query: ?workspace=<workspace_id>
 *
 * Why metrics are fetched here rather than folded into loadCustomers:
 * the ClickHouse subscriber count runs ~8s for a handful of ids, which
 * is fine for a lazily-mounted section and emphatically not fine on
 * the critical path of every profile render. The client island calls
 * this on mount, same posture as the News and Requests sections.
 *
 * Auth: signed-in viewer + the `child-workspaces` flag (id kept for continuity). GET is gated
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
    const links = await getManagedWorkspaces(parentId);
    let metrics = new Map<string, ManagedWorkspaceMetrics>();
    if (links.length > 0) {
      try {
        metrics = await fetchManagedWorkspaceMetrics(
          links.map((l) => l.workspace_id)
        );
      } catch (e) {
        // Metrics are enrichment. A ClickHouse hiccup shouldn't hide
        // the fact that links exist — render the rows without numbers
        // rather than an empty section that reads as "none linked".
        console.error("[managed-workspaces GET] metrics fetch failed", e);
      }
    }
    return NextResponse.json({
      managed: links.map((l) => ({
        ...l,
        metrics: metrics.get(l.workspace_id) ?? null,
      })),
    });
  } catch (e) {
    console.error("[managed-workspaces GET] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load managed workspaces" },
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
  const managedId = (body.workspace_id ?? "").trim();
  if (!managedId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  // Caught here rather than letting the store throw into the 500
  // handler — it's a bad request, not a server fault, and the
  // distinction matters to anyone reading logs.
  if (managedId === parentId) {
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
    const existing = await findExistingParent(managedId);
    if (existing && existing !== parentId) {
      return NextResponse.json(
        {
          error: `That workspace is already linked as a child of ${existing}. Unlink it there first.`,
          existing_parent: existing,
        },
        { status: 409 }
      );
    }
    const link: ManagedWorkspaceLink = {
      workspace_id: managedId,
      workspace_name: body.workspace_name?.trim() || null,
      note: body.note?.trim() || null,
      linked_by: g.email.toLowerCase(),
      linked_at: new Date().toISOString(),
    };
    const managed = await addManagedWorkspace(parentId, link);
    try {
      await appendActionLog([
        {
          workspace_id: parentId,
          text: `Linked managed workspace: ${link.workspace_name ?? managedId}`,
          created_by: g.email.toLowerCase(),
          action_kind: "managed_workspace_linked",
          metadata: { managed_workspace_id: managedId },
        },
      ]);
    } catch (e) {
      // Paper trail is nice-to-have; the link already landed.
      console.warn("[managed-workspaces POST] action log failed", e);
    }
    return NextResponse.json({ ok: true, managed });
  } catch (e) {
    console.error("[managed-workspaces POST] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to link workspace" },
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
  const managedId = (new URL(req.url).searchParams.get("workspace") ?? "").trim();
  if (!managedId) {
    return NextResponse.json(
      { error: "?workspace=<workspace_id> is required" },
      { status: 400 }
    );
  }
  try {
    const managed = await removeManagedWorkspace(parentId, managedId);
    try {
      await appendActionLog([
        {
          workspace_id: parentId,
          text: `Unlinked managed workspace ${managedId}`,
          created_by: g.email.toLowerCase(),
          action_kind: "managed_workspace_unlinked",
          metadata: { managed_workspace_id: managedId },
        },
      ]);
    } catch (e) {
      console.warn("[managed-workspaces DELETE] action log failed", e);
    }
    return NextResponse.json({ ok: true, managed });
  } catch (e) {
    console.error("[managed-workspaces DELETE] failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to unlink workspace" },
      { status: 500 }
    );
  }
}
