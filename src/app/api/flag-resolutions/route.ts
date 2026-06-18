import { NextResponse } from "next/server";
import { loadResolutions, setResolution } from "@/lib/data/flag-resolutions";
import type { RiskFlagCode } from "@/lib/types";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const map = await loadResolutions();
    return NextResponse.json(map);
  } catch (error) {
    console.error("Failed to load resolutions:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface PostBody {
  workspace_id: string;
  flag_code: RiskFlagCode;
  resolved: boolean;
  resolved_by?: string | null;
  note?: string | null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PostBody;
    if (!body.workspace_id || !body.flag_code) {
      return NextResponse.json(
        { error: "workspace_id and flag_code are required" },
        { status: 400 }
      );
    }
    const map = await setResolution(
      body.workspace_id,
      body.flag_code,
      Boolean(body.resolved),
      { resolvedBy: body.resolved_by, note: body.note }
    );
    await appendActionLog([
      {
        workspace_id: body.workspace_id,
        text: body.resolved
          ? `Flag ${body.flag_code} resolved`
          : `Flag ${body.flag_code} unresolved`,
        created_by: body.resolved_by?.toLowerCase() ?? undefined,
        action_kind: "flag_resolution",
        metadata: { flag_code: body.flag_code, resolved: Boolean(body.resolved) },
      },
    ]);
    return NextResponse.json(map);
  } catch (error) {
    console.error("Failed to update resolution:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
