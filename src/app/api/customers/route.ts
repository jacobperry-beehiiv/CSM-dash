import { NextResponse } from "next/server";
import { filterCustomers, loadCustomers } from "@/lib/data/load-customers";
import type { Segment } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const csm = url.searchParams.get("csm") ?? null;
    const segment = (url.searchParams.get("segment") as Segment | null) ?? "all";
    const all = await loadCustomers();
    const filtered = filterCustomers(all, { csm, segment });
    return NextResponse.json(filtered);
  } catch (error) {
    console.error("Failed to fetch customers:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
