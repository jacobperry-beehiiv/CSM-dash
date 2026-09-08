import { NextResponse } from "next/server";
import { auth } from "@/auth";
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
  // Outstanding = anything not in a shipped or dismissed state.
  // Delivered = anything currently in a Live bucket. (Not planned
  // counts as neither; it's just "off the table.")
  let outstanding = 0;
  let delivered = 0;
  for (const r of rows) {
    if (r.derived_state === "Live" || r.derived_state === "Live, possibly in beta") {
      delivered += 1;
    } else if (r.derived_state === "Open" || r.derived_state === "In progress") {
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
