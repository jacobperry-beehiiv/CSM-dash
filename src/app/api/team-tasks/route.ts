import { NextResponse } from "next/server";
import {
  applyTeamTaskOps,
  getTeamTasks,
  saveTeamTasks,
  type TeamTaskOp,
} from "@/lib/team-tasks/store";
import type { TeamTaskList } from "@/lib/team-tasks/types";

export const dynamic = "force-dynamic";

/**
 * GET   /api/team-tasks → current { tasks, members } list.
 * PATCH /api/team-tasks → atomic ops list (preferred). The server does
 *                         a fresh read-modify-write per call so
 *                         concurrent edits from different CSMs merge
 *                         instead of stomping. See applyTeamTaskOps.
 * PUT   /api/team-tasks → replace the entire list. Retained for the
 *                         rare cases (bulk import, settings page) where
 *                         a full overwrite is genuinely intended. Race-y
 *                         by design — prefer PATCH from interactive UI.
 */

export async function GET() {
  try {
    const list = await getTeamTasks();
    return NextResponse.json(list);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as TeamTaskList;
    if (!body || !Array.isArray(body.tasks)) {
      return NextResponse.json(
        { error: "Body must include a `tasks` array." },
        { status: 400 }
      );
    }
    const saved = await saveTeamTasks(body);
    return NextResponse.json(saved);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { ops?: TeamTaskOp[] };
    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      return NextResponse.json(
        { error: "Body must include a non-empty `ops` array." },
        { status: 400 }
      );
    }
    // Light validation — discriminator + required-keys check. We
    // trust the body otherwise; this isn't a public API.
    for (const op of body.ops) {
      if (
        !op ||
        typeof op !== "object" ||
        !(op.type === "cycle" ||
          op.type === "patch" ||
          op.type === "add" ||
          op.type === "delete")
      ) {
        return NextResponse.json(
          { error: "Each op must have a valid `type` field." },
          { status: 400 }
        );
      }
    }
    const saved = await applyTeamTaskOps(body.ops);
    return NextResponse.json(saved);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
