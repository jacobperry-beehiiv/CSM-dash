import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { applyTodoOps, getTodosForUser } from "@/lib/personal-todos/store";
import { userKeyFromEmail } from "@/lib/personal-todos/identity";
import { todayYmdUtc, type PersonalTodoOp } from "@/lib/personal-todos/types";

export const dynamic = "force-dynamic";

/**
 * GET   /api/personal-todos              → current user's todos
 *         ?include=scheduled             → also include rows whose
 *                                          surface_at is still in the
 *                                          future (default hides them)
 * PATCH /api/personal-todos              → atomic ops on the current
 *                                          user's slice. Same op model
 *                                          as team-tasks (add/patch/
 *                                          toggle_complete/delete) but
 *                                          scoped to the logged-in
 *                                          user only — never cross-user.
 *
 * Auth: NextAuth session required. The user's @beehiiv.com email is
 * the canonical key (lower-cased).
 */

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  try {
    const userKey = userKeyFromEmail(session.user.email);
    const url = new URL(req.url);
    const includeScheduled = url.searchParams.get("include") === "scheduled";
    const all = await getTodosForUser(userKey);
    const today = todayYmdUtc();
    const todos = includeScheduled
      ? all
      : all.filter((t) => !t.surface_at || t.surface_at <= today);
    return NextResponse.json({ todos });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  try {
    const body = (await req.json()) as { ops?: PersonalTodoOp[] };
    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      return NextResponse.json(
        { error: "Body must include a non-empty `ops` array." },
        { status: 400 }
      );
    }
    // Light discriminator check — same shape as team-tasks PATCH.
    for (const op of body.ops) {
      if (
        !op ||
        typeof op !== "object" ||
        !(op.type === "add" ||
          op.type === "patch" ||
          op.type === "toggle_complete" ||
          op.type === "delete")
      ) {
        return NextResponse.json(
          { error: "Each op must have a valid `type` field." },
          { status: 400 }
        );
      }
    }
    const userKey = userKeyFromEmail(session.user.email);
    const todos = await applyTodoOps(userKey, body.ops);
    return NextResponse.json({ todos });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
