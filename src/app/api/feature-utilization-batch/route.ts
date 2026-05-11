import { NextResponse } from "next/server";
import { runFeatureUtilizationBatch } from "@/lib/engines/feature-utilization-batch";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface PostBody {
  organization_ids: string[];
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PostBody;
    if (!Array.isArray(body.organization_ids)) {
      return NextResponse.json(
        { error: "organization_ids must be an array" },
        { status: 400 }
      );
    }
    const map = await runFeatureUtilizationBatch(body.organization_ids);
    return NextResponse.json(map);
  } catch (error) {
    console.error("feature-utilization-batch failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
