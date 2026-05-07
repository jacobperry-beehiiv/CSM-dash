import { NextResponse } from "next/server";
import { runAtRiskCheck } from "@/lib/engines/at-risk";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const csmParam = url.searchParams.get("csm");
    const all = url.searchParams.get("all") === "1";
    const csmName = all ? null : (csmParam ?? process.env.CSM_NAME ?? null);

    const result = await runAtRiskCheck({ csmName });
    return NextResponse.json(result);
  } catch (error) {
    console.error("At-risk run failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
