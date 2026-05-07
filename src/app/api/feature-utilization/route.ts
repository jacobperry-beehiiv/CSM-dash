import { NextResponse } from "next/server";
import { runFeatureUtilization } from "@/lib/engines/feature-utilization";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("org");
    if (!orgId) {
      return NextResponse.json(
        { error: "Missing required `org` query param" },
        { status: 400 }
      );
    }
    const result = await runFeatureUtilization(orgId);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Feature utilization run failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
