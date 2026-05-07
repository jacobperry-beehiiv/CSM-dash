import { NextResponse } from "next/server";
import {
  listTiers,
  replaceTiers,
  type EnterpriseTier,
} from "@/lib/tiers/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const list = await listTiers();
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
    const body = (await req.json()) as { tiers: EnterpriseTier[] };
    if (!Array.isArray(body.tiers)) {
      return NextResponse.json(
        { error: "Body must be { tiers: EnterpriseTier[] }" },
        { status: 400 }
      );
    }
    const list = await replaceTiers(body.tiers);
    return NextResponse.json(list);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 }
    );
  }
}
