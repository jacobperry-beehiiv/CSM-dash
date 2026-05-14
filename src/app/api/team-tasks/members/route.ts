import { NextResponse } from "next/server";
import { saveTeamMembers } from "@/lib/team-tasks/store";
import type { TeamMember } from "@/lib/team-tasks/types";

export const dynamic = "force-dynamic";

/**
 * PUT /api/team-tasks/members → replace just the roster.
 *
 * Why a dedicated route: the main /api/team-tasks PUT takes the whole
 * { tasks, members } payload. If /settings/team called that, an admin's
 * roster edit (fetched 10s ago) could overwrite tasks a CSM has
 * autosaved in the meantime. This route reads the latest state on the
 * server and swaps only `members`, so the two edit paths can't stomp
 * each other.
 */
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { members?: TeamMember[] };
    if (!Array.isArray(body.members)) {
      return NextResponse.json(
        { error: "Body must include a `members` array." },
        { status: 400 }
      );
    }
    // Trim invalid rows server-side.
    const valid = body.members.filter(
      (m): m is TeamMember =>
        typeof m?.id === "string" &&
        m.id.length > 0 &&
        typeof m.label === "string" &&
        m.label.trim().length > 0
    );
    if (valid.length === 0) {
      return NextResponse.json(
        { error: "Roster must include at least one valid member." },
        { status: 400 }
      );
    }
    const saved = await saveTeamMembers(valid);
    return NextResponse.json(saved);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
