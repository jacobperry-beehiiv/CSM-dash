import { NextResponse } from "next/server";
import { getTeamTasks, saveTeamTasks } from "@/lib/team-tasks/store";
import type { TeamTaskList } from "@/lib/team-tasks/types";

export const dynamic = "force-dynamic";

/**
 * GET  /api/team-tasks → current { tasks, members } list (hydrated with
 *                       the latest default roster on top of whatever's
 *                       in the KV).
 * PUT  /api/team-tasks → replace the entire list. Client autosaves the
 *                       whole list whenever any field changes — small
 *                       payload (<10 rows × 8 members) so the simplicity
 *                       wins over diffing.
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
