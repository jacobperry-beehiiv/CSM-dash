import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  clearRequestNotified,
  loadEnterpriseRequestsSnapshot,
  markRequestDrafted,
  markRequestNotified,
} from "@/lib/data/enterprise-requests";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";

/**
 * POST /api/enterprise-requests/notify
 *
 * Body: `{ workspace_id, linear_issue_id, action }`
 *   - action: "drafted" — CSM opened the outreach draft. Stamps
 *     drafted_at + drafted_by. Fires even if the CSM abandons the
 *     modal so the row still reflects "at least engaged."
 *   - action: "notified" — CSM confirms they sent the outreach.
 *     Stamps notified_at + notified_by. This is what removes the
 *     row from the weekly digest queue.
 *   - action: "cleared" — undo, drops both timestamps.
 *
 * Best-effort action_log write per (workspace, action) so the
 * profile Notes surface reflects the CSM's engagement. Failure
 * to log doesn't block the notify write — same posture as the
 * other bulk-review endpoints.
 *
 * Session-auth only. Any CSM can toggle their own accounts.
 */

interface Body {
  workspace_id?: string;
  linear_issue_id?: string;
  action?: "drafted" | "notified" | "cleared";
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = (body.workspace_id ?? "").trim();
  const linearIssueId = (body.linear_issue_id ?? "").trim();
  const action = body.action;
  if (!workspaceId || !linearIssueId || !action) {
    return NextResponse.json(
      { error: "workspace_id, linear_issue_id, and action are required" },
      { status: 400 }
    );
  }
  if (
    action !== "drafted" &&
    action !== "notified" &&
    action !== "cleared"
  ) {
    return NextResponse.json(
      { error: `Unknown action "${action}"` },
      { status: 400 }
    );
  }

  // Resolve the request title for the audit-log text — pulls from the
  // snapshot so the note reads standalone in the Notes feed
  // ("Drafted outreach for REQ-2207: Send API scheduling") without
  // requiring the reader to click through to Linear.
  let requestLabel = linearIssueId;
  try {
    const snapshot = await loadEnterpriseRequestsSnapshot();
    const row = snapshot.rows[workspaceId]?.[linearIssueId];
    if (row) {
      requestLabel = `${row.linear_identifier}: ${row.title}`;
    }
  } catch {
    // Snapshot missing / KV blip — keep the fallback label.
  }

  if (action === "drafted") {
    await markRequestDrafted(workspaceId, linearIssueId, email);
  } else if (action === "notified") {
    await markRequestNotified(workspaceId, linearIssueId, email);
  } else {
    await clearRequestNotified(workspaceId, linearIssueId);
  }

  // Best-effort audit — matches the deliverability-cleared /
  // outreach-made pattern.
  try {
    await appendActionLog([
      {
        workspace_id: workspaceId,
        text:
          action === "drafted"
            ? `Drafted feature-shipped outreach for ${requestLabel}`
            : action === "notified"
              ? `Marked customer notified about ${requestLabel}`
              : `Cleared notified state for ${requestLabel}`,
        created_by: email.toLowerCase(),
        action_kind: `enterprise_request_${action}`,
        metadata: { linear_issue_id: linearIssueId },
      },
    ]);
  } catch (e) {
    console.warn("[enterprise-requests/notify] action_log append failed", e);
  }

  return NextResponse.json({ ok: true, action });
}
