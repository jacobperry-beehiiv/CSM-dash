import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  clearPost,
  unclearPost,
} from "@/lib/data/deliverability-clears";

export const dynamic = "force-dynamic";

/**
 * POST   /api/deliverability/clear  { post_id, reason? }
 *   → records a "clear" resolution for that send. Future runs of the
 *     deliverability engine attach the clear to the alert so the panel
 *     can hide it by default (or show it with the "Cleared" pill when
 *     the "Show cleared" toggle is on).
 *
 * DELETE /api/deliverability/clear  { post_id }
 *   → un-clears (admin pressed "undo" on a previously cleared row).
 *
 * Auth: signed-in session only. The `cleared_by` field gets stamped
 * with the viewer's email so other CSMs can see who handled it.
 */

interface Body {
  post_id?: string;
  reason?: string;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const postId = (body.post_id ?? "").trim();
  if (!postId) {
    return NextResponse.json(
      { error: "post_id is required." },
      { status: 400 }
    );
  }
  const reason = (body.reason ?? "").trim() || null;
  await clearPost(postId, { clearedBy: session.user.email, reason });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const postId = (body.post_id ?? "").trim();
  if (!postId) {
    return NextResponse.json(
      { error: "post_id is required." },
      { status: 400 }
    );
  }
  await unclearPost(postId);
  return NextResponse.json({ ok: true });
}
