import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import {
  loadEnterpriseRequestsSnapshot,
  loadNotifiedOverlay,
} from "@/lib/data/enterprise-requests";
import type {
  EnterpriseRequestRow,
  NotifiedEntry,
} from "@/lib/data/enterprise-requests-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/enterprise-requests/live-this-week?csm=<email-or-handle>
 *
 * Returns every request row for the caller's book whose `promoted_at`
 * fell in the last 7 days AND whose `notified_at` is unset. Feeds the
 * "Live This Week" tab on /csm — the CSM's outreach action queue for
 * shipped features from their accounts.
 *
 * Scoping mirrors resolveCsmFilter's semantics: pass a CSM handle
 * (matched against Customer.customer_success_manager, underscore or
 * space-separated) OR an email (matched against
 * customer_success_manager_email). Empty/missing = the caller's own
 * book (viewer email → their assigned accounts).
 *
 * Includes rows with `notified_at` set as well when the caller passes
 * `?include_notified=1` — the UI uses this for the "show completed
 * this week" toggle, so a CSM can eyeball what they already handled
 * without opening every profile.
 *
 * Session-auth only; no admin gate.
 */

interface RowWithContext extends EnterpriseRequestRow {
  workspace_id: string;
  workspace_name: string | null;
  notified: NotifiedEntry;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const session = await auth();
  const viewerEmail = session?.user?.email;
  if (!viewerEmail) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const url = new URL(req.url);
  const csmParam = (url.searchParams.get("csm") ?? "").trim().toLowerCase();
  const includeNotified = url.searchParams.get("include_notified") === "1";

  const [customers, snapshot, notified] = await Promise.all([
    loadCustomers(),
    loadEnterpriseRequestsSnapshot(),
    loadNotifiedOverlay(),
  ]);

  // Resolve target CSM: explicit param wins; empty/missing = viewer's
  // own book. Match against both the display handle (case-insensitive,
  // underscores treated as spaces) and the CSM email.
  const targetEmail = csmParam.includes("@")
    ? csmParam
    : viewerEmail.toLowerCase();
  const targetHandle = csmParam.includes("@") ? null : csmParam;

  const scopedWorkspaces = new Map<
    string,
    { workspace_id: string; workspace_name: string | null }
  >();
  for (const c of customers) {
    if (!c.workspace_id) continue;
    const email = (c.customer_success_manager_email ?? "").toLowerCase();
    const handle = (c.customer_success_manager ?? "")
      .replace(/\s+/g, "_")
      .toLowerCase();
    const matches = targetHandle
      ? handle === targetHandle
      : email === targetEmail;
    if (!matches) continue;
    scopedWorkspaces.set(c.workspace_id, {
      workspace_id: c.workspace_id,
      workspace_name: c.workspace_name ?? null,
    });
  }

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const rows: RowWithContext[] = [];
  for (const [workspaceId, meta] of scopedWorkspaces) {
    const bucket = snapshot.rows[workspaceId];
    if (!bucket) continue;
    const notifiedBucket = notified.rows[workspaceId] ?? {};
    for (const row of Object.values(bucket)) {
      if (!row.promoted_at) continue;
      const promotedAt = Date.parse(row.promoted_at);
      if (!Number.isFinite(promotedAt) || promotedAt < cutoff) continue;
      const entry = notifiedBucket[row.linear_issue_id] ?? {};
      if (entry.notified_at && !includeNotified) continue;
      rows.push({
        ...row,
        workspace_id: workspaceId,
        workspace_name: meta.workspace_name,
        notified: entry,
      });
    }
  }
  // Newest first — most-recent ship at the top matches the "this
  // week" mental model.
  rows.sort((a, b) => (b.promoted_at ?? "").localeCompare(a.promoted_at ?? ""));

  return NextResponse.json({
    csm: csmParam || viewerEmail.toLowerCase(),
    rows,
    count: rows.length,
    last_synced_at: snapshot.fetched_at,
  });
}
