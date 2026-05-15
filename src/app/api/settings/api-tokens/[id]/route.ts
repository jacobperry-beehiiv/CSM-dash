import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { revokeToken } from "@/lib/auth/api-tokens";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/settings/api-tokens/<id>
 *   → 200 { ok: true } if a token belonging to the session user was
 *     removed.
 *   → 404 if no such token exists for this user (someone else's id
 *     is treated the same as "not found" so we don't leak existence).
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: "Not signed in." },
      { status: 401 }
    );
  }
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json(
      { error: "token id is required in the URL" },
      { status: 400 }
    );
  }
  try {
    const ok = await revokeToken(session.user.email, id);
    if (!ok) {
      return NextResponse.json(
        { error: "token not found for this user" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
