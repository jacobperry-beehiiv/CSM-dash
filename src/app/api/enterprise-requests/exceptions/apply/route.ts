import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { applyRequestReview } from "@/lib/data/enterprise-requests";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * POST /api/enterprise-requests/exceptions/apply
 *
 * Clears one row out of the shipped-detection exceptions queue.
 *
 * Body: `{ workspace_id, linear_issue_id, decision, note? }` where
 * decision is `"confirmed"` or `"dismissed"`.
 *
 *   • confirmed — we believe the ship is real and customer-visible.
 *     Flips `promotion_confidence`, which makes the row eligible for
 *     the next weekly digest. This endpoint deliberately does NOT
 *     send anything itself: the digest owns CSM notification, and
 *     duplicating that here would bypass its dedupe blob.
 *   • dismissed — not a customer-visible ship. Records the decision
 *     and drops `derived_state` back to the Linear-derived bucket so
 *     the customer profile stops showing a Live badge.
 *
 * Session-auth + `enterprise-requests` flag, same gate as the rest of
 * the loop's admin surfaces.
 */

interface Body {
  workspace_id?: string;
  linear_issue_id?: string;
  decision?: "confirmed" | "dismissed";
  note?: string | null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("enterprise-requests", email))) {
    return NextResponse.json(
      { error: "Enterprise Request Loop is not enabled for you." },
      { status: 403 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const workspaceId = (body.workspace_id ?? "").trim();
  const linearIssueId = (body.linear_issue_id ?? "").trim();
  const decision = body.decision;
  if (
    !workspaceId ||
    !linearIssueId ||
    (decision !== "confirmed" && decision !== "dismissed")
  ) {
    return NextResponse.json(
      {
        error:
          "workspace_id, linear_issue_id and decision ('confirmed' | 'dismissed') are required.",
      },
      { status: 400 }
    );
  }

  const row = await applyRequestReview({
    workspaceId,
    linearIssueId,
    decision,
    by: email,
    note: body.note ?? null,
  });
  if (!row) {
    return NextResponse.json(
      {
        error: `No snapshot row for workspace ${workspaceId} / issue ${linearIssueId}. It may have been dropped by a sync since the page loaded.`,
      },
      { status: 404 }
    );
  }

  // Audit trail on the customer's Notes surface — best-effort, the
  // review decision already persisted.
  try {
    await appendActionLog([
      {
        workspace_id: workspaceId,
        text:
          decision === "confirmed"
            ? `Shipped request confirmed: ${row.linear_identifier} — ${row.title}`
            : `Shipped signal dismissed: ${row.linear_identifier} — ${row.title}`,
        created_by: email,
        action_kind: "enterprise_request_reviewed",
        metadata: {
          linear_issue_id: linearIssueId,
          linear_identifier: row.linear_identifier,
          decision,
          promotion_source: row.promotion_source,
          ship_url: row.ship_url,
        },
      },
    ]);
  } catch (e) {
    console.warn("[enterprise-requests/exceptions] action_log write failed", {
      error: e instanceof Error ? e.message : e,
    });
  }

  return NextResponse.json({
    ok: true,
    workspace_id: workspaceId,
    linear_issue_id: linearIssueId,
    decision,
    derived_state: row.derived_state,
    promotion_confidence: row.promotion_confidence ?? null,
  });
}
