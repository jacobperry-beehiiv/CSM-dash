import { NextResponse } from "next/server";
import { setOverride } from "@/lib/data/customer-overrides";
import { invalidateCustomerCache } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";

interface PostBody {
  workspace_id: string;
  interval?: "annual" | "month" | null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PostBody;
    if (!body.workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    const map = await setOverride(body.workspace_id, {
      interval: body.interval === null ? undefined : body.interval,
    });
    invalidateCustomerCache();
    return NextResponse.json(map);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
