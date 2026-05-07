import { NextResponse } from "next/server";
import { runDeliverabilityCheck } from "@/lib/engines/deliverability";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") ?? undefined;
    const all = url.searchParams.get("all") === "1";

    const result = await runDeliverabilityCheck({
      csmName: all ? null : undefined,
      targetDate: date,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Deliverability run failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
