import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  loadEnterpriseRequestsSnapshot,
  loadNotifiedOverlay,
} from "@/lib/data/enterprise-requests";
import {
  CLOSED_STATES,
  isLive,
  type EnterpriseRequestRow,
  type NotifiedEntry,
} from "@/lib/data/enterprise-requests-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/enterprise-requests?workspace_id=<uuid>
 *
 * Returns the request rows for one customer plus the merged notified
 * overlay. Consumed by the CustomerRequestsSection on the profile.
 * Also aggregates outstanding-vs-delivered counts for the section
 * header — cheap to compute here and saves the client from re-
 * walking the row list to derive them.
 *
 * Session-auth only — no admin gate; any signed-in CSM can read.
 */

interface RowWithNotified extends EnterpriseRequestRow {
  notified: NotifiedEntry;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  // The Enterprise Request Loop ships dark. The UI honours the flag,
  // but hiding a tab doesn't hide its endpoint — without this, any
  // signed-in CSM could read the whole book's request data straight
  // off the API. 404, not 403, to match the pages.
  if (!(await isFeatureEnabledFor("enterprise-requests", session.user.email))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspace_id") ?? "").trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  const [snapshot, notified] = await Promise.all([
    loadEnterpriseRequestsSnapshot(),
    loadNotifiedOverlay(),
  ]);
  const bucket = snapshot.rows[workspaceId] ?? {};
  const notifiedBucket = notified.rows[workspaceId] ?? {};
  const rows: RowWithNotified[] = Object.values(bucket).map((r) => ({
    ...r,
    notified: notifiedBucket[r.linear_issue_id] ?? {},
  }));
  // Delivered = Linear says it's live in the app.
  // Outstanding = still somewhere in the pipeline. Canceled and
  // Duplicate count as neither — they're off the table, and counting
  // them as outstanding is what made dismissed requests read to a CSM
  // as still-open asks.
  let outstanding = 0;
  let delivered = 0;
  for (const r of rows) {
    if (isLive(r)) {
      delivered += 1;
    } else if (!CLOSED_STATES.has(r.derived_state)) {
      outstanding += 1;
    }
  }
  return NextResponse.json({
    workspace_id: workspaceId,
    rows,
    outstanding,
    delivered,
    last_synced_at: snapshot.fetched_at,
  });
}
