import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadOverrides, setOverride } from "@/lib/data/customer-overrides";
import { invalidateCustomerCache } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";

/** GET — current overrides map keyed by workspace_id. Lets the
 *  Renewals panel pull just the lifecycle_stage values + audit
 *  metadata without re-running loadCustomers. */
export async function GET() {
  try {
    const map = await loadOverrides();
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface PostBody {
  workspace_id: string;
  interval?: "annual" | "month" | null;
  /** Update the user-facing lifecycle stage (renewals dropdown). Pass
   *  null or empty string to clear. Audit fields are stamped from the
   *  session viewer's email. */
  lifecycle_stage?: string | null;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const body = (await req.json()) as PostBody;
    if (!body.workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }

    const patch: Parameters<typeof setOverride>[1] = {};
    if ("interval" in body) {
      patch.interval = body.interval === null ? undefined : body.interval;
    }
    if ("lifecycle_stage" in body) {
      const trimmed = body.lifecycle_stage?.trim() || "";
      patch.lifecycle_stage = trimmed || undefined;
      patch.lifecycle_stage_updated_at = trimmed
        ? new Date().toISOString()
        : undefined;
      patch.lifecycle_stage_updated_by = trimmed
        ? session?.user?.email?.toLowerCase() ?? undefined
        : undefined;
    }

    const map = await setOverride(body.workspace_id, patch);
    invalidateCustomerCache();
    return NextResponse.json(map);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
