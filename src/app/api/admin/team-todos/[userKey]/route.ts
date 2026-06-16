import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import {
  applyTodoOps,
  getTodosForUser,
  type AdminAudit,
} from "@/lib/personal-todos/store";
import type { PersonalTodoOp } from "@/lib/personal-todos/types";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * GET  /api/admin/team-todos/<userKey>
 *   → { userKey, todos }
 *
 * PATCH /api/admin/team-todos/<userKey>
 *   body: { ops: PersonalTodoOp[] }
 *   → { userKey, todos }
 *
 * Admin-only. The PATCH stamps every op with the admin's email via
 * the AdminAudit hook in applyTodoOps so the owning CSM has a clear
 * trail of who edited their list. Same op shape as the standard
 * /api/personal-todos endpoint, so the admin UI can reuse op-builder
 * logic.
 *
 * userKey comes from the URL — the admin summary endpoint returns
 * these keys directly so the client doesn't need to construct them.
 */

interface PatchBody {
  ops?: PersonalTodoOp[];
}

async function gate(): Promise<
  | { ok: true; admin: string }
  | { ok: false; res: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.email) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Sign in required." }, { status: 401 }),
    };
  }
  if (!isAdmin(session.user.email)) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Admin only." }, { status: 403 }),
    };
  }
  return { ok: true, admin: session.user.email.toLowerCase() };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ userKey: string }> }
) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { userKey } = await ctx.params;
  const decoded = decodeURIComponent(userKey);
  const todos = await getTodosForUser(decoded);
  return NextResponse.json({ userKey: decoded, todos });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ userKey: string }> }
) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { userKey } = await ctx.params;
  const decoded = decodeURIComponent(userKey);

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (ops.length === 0) {
    return NextResponse.json(
      { error: "Body must include a non-empty `ops` array" },
      { status: 400 }
    );
  }

  const audit: AdminAudit = { admin_acted_by: g.admin };
  try {
    const todos = await applyTodoOps(decoded, ops, audit);
    console.log("[admin/team-todos] applied", {
      admin: g.admin,
      target: decoded,
      ops_count: ops.length,
    });
    return NextResponse.json({ userKey: decoded, todos });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[admin/team-todos] PATCH failed", {
      admin: g.admin,
      target: decoded,
      error: msg,
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
