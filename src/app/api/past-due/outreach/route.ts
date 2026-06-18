import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  bulkSetPastDueOutreach,
  loadPastDueOutreach,
  setPastDueOutreach,
  type PastDueOutreachStatus,
} from "@/lib/data/past-due-outreach";
import { appendActionLog } from "@/lib/data/customer-signals";
import { loadCustomers } from "@/lib/data/load-customers";

/** Past-due outreach is keyed by Stripe customer_id; the audit log
 *  is keyed by workspace_id. Resolve via the customer book — same
 *  index loadPastDue + the AM panel use, so a row visible in the
 *  panel will reliably resolve here too. Rows whose Customer can't
 *  be matched silently drop from the audit (no log entry); the
 *  primary mutation has already succeeded. */
async function resolveWorkspaceIdsByStripeIds(
  customerIds: string[]
): Promise<Map<string, string>> {
  const customers = await loadCustomers();
  const idx = new Map<string, string>();
  for (const c of customers) {
    if (c.stripe_customer_id && c.workspace_id) {
      idx.set(c.stripe_customer_id, c.workspace_id);
    }
  }
  const out = new Map<string, string>();
  for (const cid of customerIds) {
    const ws = idx.get(cid);
    if (ws) out.set(cid, ws);
  }
  return out;
}

const STATUS_LABELS: Record<PastDueOutreachStatus, string> = {
  touched: "Marked touched",
  follow_up_sent: "Marked follow-up sent",
  paid: "Marked paid",
  lost: "Marked lost",
};

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
  // Audit trail — only logged when the row maps to a workspace and
  // we have a labeled status. Clears (status=null) get no entry to
  // avoid noise from accidental un-touch clicks.
  if (status) {
    const resolved = await resolveWorkspaceIdsByStripeIds([customerId]);
    const ws = resolved.get(customerId);
    if (ws) {
      await appendActionLog([
        {
          workspace_id: ws,
          text: STATUS_LABELS[status] + " (past-due)",
          created_by: session.user.email.toLowerCase(),
          action_kind: "past_due_status",
          metadata: { status, customer_id: customerId },
        },
      ]);
    }
  }
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
  const actor = session.user.email.toLowerCase();
  const map = await bulkSetPastDueOutreach(body.customer_ids, status, {
    updatedBy: actor,
    note: body.note ?? null,
  });
  // Audit trail — one entry per resolved workspace.
  const resolved = await resolveWorkspaceIdsByStripeIds(body.customer_ids);
  await appendActionLog(
    [...resolved.entries()].map(([cid, ws]) => ({
      workspace_id: ws,
      text: STATUS_LABELS[status] + " (past-due)",
      created_by: actor,
      action_kind: "past_due_status",
      metadata: { status, customer_id: cid, bulk: true },
    }))
  );
  return NextResponse.json(map);
}
