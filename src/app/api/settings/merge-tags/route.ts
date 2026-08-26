import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  listRegisteredTagNames,
  loadPerCsmMergeTags,
  savePerCsmMergeTags,
} from "@/lib/data/per-csm-merge-tags";
import type {
  PerCsmMergeTag,
  PerCsmMergeTagsResponse,
} from "@/lib/data/per-csm-merge-tags-types";

/**
 * GET  /api/settings/merge-tags
 *   Auth required. Returns the viewer's own tags + a cross-CSM list
 *   of every tag NAME registered anywhere (with a usage count). The
 *   settings page uses the cross-CSM list to nudge naming conventions
 *   — everyone should agree on `scheduling_text`, not
 *   `calendly`/`book_meeting`/`time_slot`. Values are never returned
 *   for other CSMs — those are private per-user.
 *
 * PUT  /api/settings/merge-tags
 *   { tags: PerCsmMergeTag[] }
 *   Auth required. Saves the viewer's tags after sanitization
 *   (name-format check, system-tag reservation, dedupe, length caps).
 *   Returns the sanitized stored list so the UI can surface any
 *   drops (invalid names, duplicates) immediately.
 *
 * Consumed by:
 *   - /settings/merge-tags/page.tsx (management UI)
 *   - useCustomMergeTags() client hook (outreach modal / bulk-drafts
 *     modal / template editor render preview / merge-tag library)
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  try {
    const [mine, registered] = await Promise.all([
      loadPerCsmMergeTags(email),
      listRegisteredTagNames(),
    ]);
    const body: PerCsmMergeTagsResponse = { mine, registered };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: { tags?: PerCsmMergeTag[] };
  try {
    body = (await req.json()) as { tags?: PerCsmMergeTag[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const incoming = Array.isArray(body.tags) ? body.tags : [];
  try {
    const saved = await savePerCsmMergeTags(email, incoming);
    return NextResponse.json({ tags: saved });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
