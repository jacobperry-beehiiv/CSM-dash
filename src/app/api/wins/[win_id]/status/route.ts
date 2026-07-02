import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { setStatus } from "@/lib/data/wins-store";
import type { WinStatus } from "@/lib/data/wins-types";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/wins/[win_id]/status
 *
 * Change the status of one candidate win. Phase 1 only exposes the
 * "dismissed" transition (the wins-list Dismiss button); Phases 2–4
 * will wire "approved" and "sent" transitions here too.
 *
 * Auth: NextAuth session with wins-opportunities feature flag on.
 */

const ALLOWED_TRANSITIONS: readonly WinStatus[] = [
  "candidate",
  "dismissed",
  "surfaced",
  "approved",
  "sent",
];

interface Params {
  params: Promise<{ win_id: string }>;
}

export async function PATCH(req: Request, ctx: Params) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const enabled = await isFeatureEnabledFor("wins-opportunities", email);
  if (!enabled) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { win_id } = await ctx.params;
  let payload: { status?: string } = {};
  try {
    payload = (await req.json()) as { status?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const status = payload.status;
  if (
    !status ||
    !ALLOWED_TRANSITIONS.includes(status as WinStatus)
  ) {
    return NextResponse.json(
      {
        error: `Invalid status — must be one of ${ALLOWED_TRANSITIONS.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const updated = await setStatus(win_id, status as WinStatus);
  if (!updated) {
    return NextResponse.json({ error: "Win not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, win: updated });
}
