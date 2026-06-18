import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  REVIEW_STATES,
  REVIEW_WORKFLOWS,
  loadReviewStates,
  setReviewState,
  setReviewStatesBatch,
  type ReviewState,
  type ReviewWorkflow,
} from "@/lib/data/review-states";

export const dynamic = "force-dynamic";

/**
 * GET   /api/review-states
 *   → full map keyed by workspace_id with per-workflow review entries.
 *
 * POST  /api/review-states
 *   { workspace_id, workflow, state, note? }
 *   → set or clear the review state for a single (workspace, workflow)
 *     pair. Pass `state: null` to clear back to needs-review.
 *
 * PATCH /api/review-states
 *   { workspace_ids: string[], workflow, state, note? }
 *   → apply the same (workflow, state) to every workspace_id in the
 *     list as a single KV read-modify-write. Used by the bulk-action
 *     bar on the AM panels so a 30-row "Mark Skip" is one round-trip
 *     instead of thirty.
 *
 * The viewer's session email lands on set_by as audit.
 *
 * Auth: NextAuth session only. No cron path — sweep engines read the
 * map directly via loadReviewStates().
 */

interface PostBody {
  workspace_id?: string;
  workflow?: string;
  state?: string | null;
  note?: string | null;
}

const WORKFLOW_SET: Set<string> = new Set(REVIEW_WORKFLOWS);
const STATE_SET: Set<string> = new Set(REVIEW_STATES);

export async function GET() {
  try {
    const map = await loadReviewStates();
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = (body.workspace_id ?? "").trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  const workflow = body.workflow;
  if (typeof workflow !== "string" || !WORKFLOW_SET.has(workflow)) {
    return NextResponse.json(
      {
        error: `workflow must be one of: ${REVIEW_WORKFLOWS.join(", ")}`,
      },
      { status: 400 }
    );
  }
  // body.state === null → clear. Otherwise it must be a known state.
  let nextState: ReviewState | null;
  if (body.state === null) {
    nextState = null;
  } else if (
    typeof body.state === "string" &&
    body.state !== "" &&
    STATE_SET.has(body.state)
  ) {
    nextState = body.state as ReviewState;
  } else if (body.state === "" || body.state === undefined) {
    nextState = null;
  } else {
    return NextResponse.json(
      {
        error: `state must be one of: ${REVIEW_STATES.join(", ")} (or null/empty to clear)`,
      },
      { status: 400 }
    );
  }

  try {
    const map = await setReviewState(
      workspaceId,
      workflow as ReviewWorkflow,
      nextState,
      {
        setBy: session.user.email.toLowerCase(),
        note: body.note ?? null,
      }
    );
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface PatchBody {
  workspace_ids?: unknown;
  workflow?: string;
  state?: string | null;
  note?: string | null;
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
  if (!Array.isArray(body.workspace_ids)) {
    return NextResponse.json(
      { error: "workspace_ids must be an array of strings" },
      { status: 400 }
    );
  }
  const workspaceIds = (body.workspace_ids as unknown[])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  if (workspaceIds.length === 0) {
    return NextResponse.json(
      { error: "workspace_ids cannot be empty" },
      { status: 400 }
    );
  }
  const workflow = body.workflow;
  if (typeof workflow !== "string" || !WORKFLOW_SET.has(workflow)) {
    return NextResponse.json(
      { error: `workflow must be one of: ${REVIEW_WORKFLOWS.join(", ")}` },
      { status: 400 }
    );
  }
  let nextState: ReviewState | null;
  if (body.state === null || body.state === "" || body.state === undefined) {
    nextState = null;
  } else if (typeof body.state === "string" && STATE_SET.has(body.state)) {
    nextState = body.state as ReviewState;
  } else {
    return NextResponse.json(
      {
        error: `state must be one of: ${REVIEW_STATES.join(", ")} (or null/empty to clear)`,
      },
      { status: 400 }
    );
  }
  try {
    const map = await setReviewStatesBatch({
      workspaceIds,
      workflow: workflow as ReviewWorkflow,
      state: nextState,
      setBy: session.user.email.toLowerCase(),
      note: body.note ?? null,
    });
    return NextResponse.json({
      ok: true,
      applied: workspaceIds.length,
      map,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
