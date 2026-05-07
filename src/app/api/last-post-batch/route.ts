import { NextResponse } from "next/server";
import { rollupLastWebPosts } from "@/lib/engines/last-post-batch";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { organization_ids: string[] };
    if (!Array.isArray(body.organization_ids)) {
      return NextResponse.json(
        { error: "organization_ids must be an array" },
        { status: 400 }
      );
    }
    const map = await rollupLastWebPosts(body.organization_ids);
    return NextResponse.json(Object.fromEntries(map));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
