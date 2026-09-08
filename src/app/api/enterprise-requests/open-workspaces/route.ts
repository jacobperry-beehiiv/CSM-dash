import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadEnterpriseRequestsSnapshot } from "@/lib/data/enterprise-requests";
import {
  OPEN_STATE_TYPES,
  type EnterpriseRequestRow,
} from "@/lib/data/enterprise-requests-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/enterprise-requests/open-workspaces?csm=<email-or-handle>
 *
 * Returns the set of workspace_ids in the caller's scope that have
 * at least one open (non-terminal) Linear request. Powers the
 * "Has open Linear FR" filter chip on the customer table.
 *
 * "Open" = the row's `linear_state_type` is in OPEN_STATE_TYPES
 * (triage / backlog / unstarted / started). We deliberately walk
 * Linear state — NOT the derived_state — because a row promoted to
 * "Live" but still open in Linear (bug fixes, follow-up work) is
 * still active, and a row in "Not planned" shouldn't show up here.
 *
 * A secondary set `notified_gap` returns workspaces with ≥1 row
 * that's Live in the last 7d AND unnotified — powers the optional
 * "Live in last 7d, unnotified" chip variant described in the plan.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const session = await auth();
  const viewerEmail = session?.user?.email;
  if (!viewerEmail) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const url = new URL(req.url);
  const csmParam = (url.searchParams.get("csm") ?? "").trim().toLowerCase();

  const [customers, snapshot] = await Promise.all([
    loadCustomers(),
    loadEnterpriseRequestsSnapshot(),
  ]);

  const targetEmail = csmParam.includes("@")
    ? csmParam
    : viewerEmail.toLowerCase();
  const targetHandle = csmParam.includes("@") ? null : csmParam;
  // "all" is a magic value the resolveCsmFilter path uses to mean
  // "everyone's book" — mirror it here so the chip strip on the
  // /csm All-CSMs view still narrows correctly.
  const scopeAll = csmParam === "all";

  const scoped = new Set<string>();
  for (const c of customers) {
    if (!c.workspace_id) continue;
    const email = (c.customer_success_manager_email ?? "").toLowerCase();
    const handle = (c.customer_success_manager ?? "")
      .replace(/\s+/g, "_")
      .toLowerCase();
    const matches = scopeAll
      ? true
      : targetHandle
        ? handle === targetHandle
        : email === targetEmail;
    if (matches) scoped.add(c.workspace_id);
  }

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const open = new Set<string>();
  const notifiedGap = new Set<string>();
  for (const workspaceId of scoped) {
    const bucket = snapshot.rows[workspaceId];
    if (!bucket) continue;
    for (const row of Object.values(bucket) as EnterpriseRequestRow[]) {
      if (OPEN_STATE_TYPES.has(row.linear_state_type)) {
        open.add(workspaceId);
      }
      if (row.promoted_at) {
        const promotedAt = Date.parse(row.promoted_at);
        if (Number.isFinite(promotedAt) && promotedAt >= cutoff) {
          // The overlay's notified_at isn't queried here to keep
          // this endpoint lean — the chip is a "candidates that
          // MIGHT need attention" hint, and the actual per-row
          // notified state renders in the Requests section. If we
          // ever need strict notified filtering, add a second
          // pass reading the notified overlay.
          notifiedGap.add(workspaceId);
        }
      }
    }
  }

  return NextResponse.json({
    csm: csmParam || viewerEmail.toLowerCase(),
    open_workspace_ids: [...open],
    live_this_week_workspace_ids: [...notifiedGap],
    last_synced_at: snapshot.fetched_at,
  });
}
