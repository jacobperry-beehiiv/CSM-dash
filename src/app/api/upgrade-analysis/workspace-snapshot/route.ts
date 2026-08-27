import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { runWorkspaceSnapshot } from "@/lib/engines/upgrade-analysis/workspace-snapshot";
import type { AnalysisWindow } from "@/lib/engines/upgrade-analysis/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/upgrade-analysis/workspace-snapshot
 *
 * Computes the D&C 7-metric flag table across every publication in
 * the workspace (organization) plus an aggregate row. Feeds the
 * workspace-snapshot table at the top of the D&C Upgrade Analysis
 * panel. Session-authed + gated on the same feature flag as the
 * single-pub scan.
 *
 * Body:
 *   {
 *     organizationId: string,
 *     lookback_days?: number,     // preset
 *     start_date?: string,        // YYYY-MM-DD — explicit range
 *     end_date?: string,
 *   }
 *
 * No KV persistence — this is cheaper than a full scan (one batched
 * ClickHouse query + one Postgres query) and the panel triggers it
 * on mount so a cached blob would rot. Add caching later if it
 * shows up in Vercel's slow-endpoint dashboards.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("upgrade-analysis", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    organizationId?: string;
    lookback_days?: number;
    start_date?: string;
    end_date?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const organizationId = (body.organizationId ?? "").trim();
  if (!organizationId) {
    return NextResponse.json(
      { error: "Missing organizationId" },
      { status: 400 }
    );
  }

  // Same window-parsing logic as the single-pub scan endpoint — kept
  // inline rather than shared because it's small and the endpoints
  // have independently valid shapes.
  let window: AnalysisWindow | undefined;
  const hasLookback =
    body.lookback_days !== undefined && body.lookback_days !== null;
  const hasRange =
    (body.start_date !== undefined && body.start_date !== null) ||
    (body.end_date !== undefined && body.end_date !== null);
  if (hasLookback && hasRange) {
    return NextResponse.json(
      { error: "Pass either lookback_days OR (start_date, end_date), not both" },
      { status: 400 }
    );
  }
  if (hasLookback) {
    const days = Math.floor(Number(body.lookback_days));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return NextResponse.json(
        { error: "lookback_days must be an integer between 1 and 365" },
        { status: 400 }
      );
    }
    window = { kind: "lookback", lookback_days: days };
  } else if (hasRange) {
    const YMD = /^\d{4}-\d{2}-\d{2}$/;
    const start = String(body.start_date ?? "").trim();
    const end = String(body.end_date ?? "").trim();
    if (!YMD.test(start) || !YMD.test(end)) {
      return NextResponse.json(
        { error: "start_date and end_date must be YYYY-MM-DD" },
        { status: 400 }
      );
    }
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs < startMs
    ) {
      return NextResponse.json(
        { error: "start_date must be on or before end_date" },
        { status: 400 }
      );
    }
    if (endMs - startMs > 366 * 86_400_000) {
      return NextResponse.json(
        { error: "Range must span at most 366 days" },
        { status: 400 }
      );
    }
    window = { kind: "range", start_date: start, end_date: end };
  }

  try {
    const snapshot = await runWorkspaceSnapshot(organizationId, window);
    return NextResponse.json({ ok: true, snapshot });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[workspace-snapshot] 500", { organizationId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
