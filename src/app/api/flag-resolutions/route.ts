import { NextResponse } from "next/server";
import { loadResolutions, setResolution } from "@/lib/data/flag-resolutions";
import type { RiskFlagCode } from "@/lib/types";

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
    return NextResponse.json(map);
  } catch (error) {
    console.error("Failed to update resolution:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
