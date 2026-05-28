import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  bulkSetPastDueOutreach,
  loadPastDueOutreach,
  setPastDueOutreach,
  type PastDueOutreachStatus,
} from "@/lib/data/past-due-outreach";

export const dynamic = "force-dynamic";

/**
 * GET  /api/past-due/outreach
 *   → the current outreach-status map keyed by Stripe customer_id.
 *
 * POST /api/past-due/outreach
 *   { customer_id: "cus_…", status: "touched" | "follow_up_sent" |
 *     "paid" | "lost" | null, note?: string }
 *   → single-row update. Pass status=null to clear back to untouched.
 *
 * PUT  /api/past-due/outreach
 *   { customer_ids: ["cus_…", …], status: "touched", note?: string }
 *   → bulk update (used by the bulk-draft flows so a single click
 *     marks every selected customer as touched at once).
 *
 * Auth: signed-in session only. `updated_by` carries the viewer's email.
 */

interface SingleBody {
  customer_id?: string;
  status?: PastDueOutreachStatus | null;
  note?: string;
}

interface BulkBody {
  customer_ids?: string[];
  status?: PastDueOutreachStatus;
  note?: string;
}

const VALID_STATUSES: PastDueOutreachStatus[] = [
  "touched",
  "follow_up_sent",
  "paid",
  "lost",
];

export async function GET() {
  try {
    const map = await loadPastDueOutreach();
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: SingleBody;
  try {
    body = (await req.json()) as SingleBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const customerId = (body.customer_id ?? "").trim();
  if (!customerId) {
    return NextResponse.json(
      { error: "customer_id is required" },
      { status: 400 }
    );
  }
  const status = body.status ?? null;
  if (status !== null && !VALID_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(", ")} or null` },
      { status: 400 }
    );
  }
  const map = await setPastDueOutreach(customerId, status, {
    updatedBy: session.user.email,
    note: body.note ?? null,
  });
  return NextResponse.json(map);
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.customer_ids) || body.customer_ids.length === 0) {
    return NextResponse.json(
      { error: "customer_ids must be a non-empty array" },
      { status: 400 }
    );
  }
  const status = body.status;
  if (!status || !VALID_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }
  const map = await bulkSetPastDueOutreach(body.customer_ids, status, {
    updatedBy: session.user.email,
    note: body.note ?? null,
  });
  return NextResponse.json(map);
}
