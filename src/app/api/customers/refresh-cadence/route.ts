import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import { loadCustomers } from "@/lib/data/load-customers";
import {
  DEFAULT_LOOKBACK_DAYS,
  computeCadenceRows,
  fetchSendDates,
  loadCadenceOverlay,
  pruneCadenceOverlay,
  saveCadenceOverlay,
  type CadenceBlob,
  type CadenceRow,
} from "@/lib/data/send-cadence";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/customers/refresh-cadence
 *
 * Recomputes the per-workspace inferred send cadence used by Flag A's
 * "cadence + 14d tolerance" threshold. Reads every workspace's
 * `send_status = 2` posts from ClickHouse over the last
 * DEFAULT_LOOKBACK_DAYS days, medians the inter-send intervals, and
 * writes the result into the send-cadence KV overlay.
 *
 * Auth: cron bearer OR any signed-in CSM team member (manual button
 * from settings, once we surface one).
 *
 * Runs daily via .github/workflows/cadence-refresh.yml.
 */

async function authorize(req: Request): Promise<"cron" | "manual" | false> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.get("authorization") ?? "";
    if (header === `Bearer ${cronSecret}`) return "cron";
  }
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (email && (await isCsmTeamMember(email))) return "manual";
  return false;
}

export async function POST(req: Request) {
  const triggeredBy = await authorize(req);
  if (!triggeredBy) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const lookbackParam = Number(url.searchParams.get("lookback") ?? "");
  const lookback =
    Number.isFinite(lookbackParam) && lookbackParam > 0
      ? Math.min(Math.floor(lookbackParam), 365)
      : DEFAULT_LOOKBACK_DAYS;

  const customers = await loadCustomers();
  const workspaceIds = Array.from(
    new Set(
      customers
        .map((c) => c.workspace_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  );

  console.log("[customers/refresh-cadence]", {
    triggered_by: triggeredBy,
    lookback,
    workspaces: workspaceIds.length,
  });

  const sendDates = await fetchSendDates(workspaceIds, lookback);
  const computed = computeCadenceRows(sendDates, lookback);
  const fetchedAt = new Date().toISOString();

  const rows: Record<string, CadenceRow> = {};
  for (const [workspaceId, row] of computed.entries()) {
    rows[workspaceId] = { ...row, fetched_at: fetchedAt };
  }

  const blob: CadenceBlob = { rows, fetched_at: fetchedAt };
  await saveCadenceOverlay(blob);

  // Prune rows for workspaces no longer in the book — best-effort;
  // saveCadenceOverlay already wrote the fresh blob so any leftover
  // stale rows would be from workspaces that dropped between the read
  // and this call.
  const kept = new Set(Object.keys(rows));
  await pruneCadenceOverlay(kept);

  return NextResponse.json({
    ok: true,
    triggered_by: triggeredBy,
    workspaces: workspaceIds.length,
    posts_scanned: sendDates.length,
    cadence_rows: Object.keys(rows).length,
    lookback_days: lookback,
    generated_at: fetchedAt,
  });
}
