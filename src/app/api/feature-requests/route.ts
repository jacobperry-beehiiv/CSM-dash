import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  applyFeatureRequestOps,
  loadFeatureRequests,
} from "@/lib/feature-requests/store";
import { notifySubmitterOfComment } from "@/lib/feature-requests/notify";
import type { FeatureRequestOp } from "@/lib/feature-requests/types";

export const dynamic = "force-dynamic";

/**
 * Feature request board API.
 *
 *   GET  /api/feature-requests
 *     → { requests: FeatureRequest[] }
 *
 *   PATCH /api/feature-requests
 *     body: { ops: FeatureRequestOp[] }
 *     → { requests: FeatureRequest[] }  (the updated list)
 *
 * Auth: any signed-in @beehiiv.com viewer. No per-row ownership
 * gating in v1 — anyone can edit / delete / reorder. The board is
 * collaborative by design (this matches how the team-tasks panel
 * works). If we need stricter rules later (only admins can reorder,
 * only the submitter can edit description, etc.) we can layer them
 * in the op switch.
 *
 * The atomic-ops PATCH shape (vs. a "POST the whole list" pattern)
 * means concurrent edits from different CSMs merge instead of
 * stomping — same trick as team-tasks.
 */

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const list = await loadFeatureRequests();
  return NextResponse.json(list);
}

interface PatchBody {
  ops?: FeatureRequestOp[];
}

function humanizeViewer(email: string): string {
  const prefix = email.split("@")[0] ?? "";
  return prefix
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** Client sends `{ type: "comment", requestId, body }` — the route
 *  stamps author fields from the session so callers can't impersonate. */
function normalizeOps(
  raw: FeatureRequestOp[],
  viewerEmail: string
): FeatureRequestOp[] {
  const authorEmail = viewerEmail.trim().toLowerCase();
  const authorName = humanizeViewer(viewerEmail);
  return raw.map((op) => {
    if (op.type !== "comment") return op;
    return {
      ...op,
      author_email: authorEmail,
      author_name: authorName,
    };
  });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
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
  // Light validation: each op needs a recognized `type`. Anything
  // exotic (unknown discriminator) gets rejected before we touch KV.
  for (const op of ops) {
    if (
      !op ||
      typeof op !== "object" ||
      typeof (op as { type?: unknown }).type !== "string"
    ) {
      return NextResponse.json(
        { error: "Each op must be an object with a `type` field" },
        { status: 400 }
      );
    }
  }
  const viewerEmail = session.user.email;
  const normalized = normalizeOps(ops, viewerEmail);

  try {
    const list = await applyFeatureRequestOps(normalized);

    for (const op of normalized) {
      if (op.type !== "comment") continue;
      const request = list.requests.find((r) => r.id === op.requestId);
      const comment = request?.comments?.at(-1);
      if (!request || !comment) continue;
      const notify = await notifySubmitterOfComment({ request, comment });
      if (!notify.sent && notify.reason) {
        console.warn("[feature-requests] comment saved, DM skipped", {
          requestId: op.requestId,
          reason: notify.reason,
        });
      }
    }

    return NextResponse.json(list);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[feature-requests PATCH]", { msg, ops_count: ops.length });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
