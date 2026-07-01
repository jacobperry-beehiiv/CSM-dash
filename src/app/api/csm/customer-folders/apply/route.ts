import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadCustomers } from "@/lib/data/load-customers";
import { patchHubspotCompanyProperties } from "@/lib/integrations/hubspot";
import { appendActionLog } from "@/lib/data/customer-signals";
import {
  loadSweepState,
  markApplied,
  saveSweepState,
  setSelection,
} from "@/lib/data/customer-folders-sweep-state";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * POST /api/csm/customer-folders/apply
 *
 * Walks the review queue and writes the CSM's approved matches back
 * to HubSpot's `customer_folder` property. Skips any row whose
 * target workspace already has a value set — the sweep never
 * overwrites, matching the design decision.
 *
 * Body (optional):
 *   { selections?: Array<{ folder_id, selection: "approved"|"skipped", workspace_id? }> }
 *
 * When `selections` is provided, we PATCH the queue with those
 * choices first (so the settings UI can send the CSM's manual picks
 * in the same request that applies). Then we iterate every
 * approved-not-yet-applied row and write.
 *
 * Response:
 *   { ok, applied, skipped_already_set, failed, errors[] }
 *
 * Auth: flag-gated (same as /scan).
 */

interface PostBody {
  selections?: Array<{
    folder_id: string;
    selection: "approved" | "skipped" | "pending";
    workspace_id?: string;
  }>;
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("customer-folders-sweep", email))) {
    return NextResponse.json(
      { error: "Feature not available for this account" },
      { status: 403 }
    );
  }

  let body: PostBody = {};
  try {
    body = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as PostBody)
      : {};
  } catch {
    body = {};
  }

  const state = await loadSweepState();

  // Absorb caller-supplied selection edits first. Empty body →
  // nothing to update, just apply whatever's already approved.
  for (const sel of body.selections ?? []) {
    if (sel.selection === "approved") {
      if (!sel.workspace_id) continue;
      setSelection(state, sel.folder_id, {
        kind: "approved",
        workspace_id: sel.workspace_id,
      });
    } else if (sel.selection === "skipped") {
      setSelection(state, sel.folder_id, { kind: "skipped" });
    } else if (sel.selection === "pending") {
      setSelection(state, sel.folder_id, { kind: "pending" });
    }
  }

  // Freshen customer view so we can re-check the "already set" gate
  // right before the write.
  const customers = await loadCustomers();
  const byWorkspace = new Map(
    customers
      .filter((c): c is typeof c & { workspace_id: string } => Boolean(c.workspace_id))
      .map((c) => [c.workspace_id, c])
  );

  let applied = 0;
  let skipped_already_set = 0;
  let failed = 0;
  const errors: Array<{ folder_id: string; workspace_id: string; error: string }> = [];
  const auditEvents: Array<Parameters<typeof appendActionLog>[0][number]> = [];

  for (const row of Object.values(state.queue)) {
    if (row.selection.kind !== "approved") continue;
    if (row.applied_at) continue;
    const workspace_id = row.selection.workspace_id;
    const customer = byWorkspace.get(workspace_id);
    if (!customer || !customer.hubspot_company_id) {
      failed++;
      errors.push({
        folder_id: row.folder_id,
        workspace_id,
        error: "Customer has no HubSpot company link — cannot patch.",
      });
      continue;
    }
    if (
      typeof customer.property_customer_folder === "string" &&
      customer.property_customer_folder.trim().length > 0
    ) {
      skipped_already_set++;
      // Stamp applied so the row moves out of the review queue.
      markApplied(state, row.folder_id, workspace_id);
      continue;
    }
    try {
      await patchHubspotCompanyProperties(customer.hubspot_company_id, {
        customer_folder: row.folder_url,
      });
      markApplied(state, row.folder_id, workspace_id);
      applied++;
      auditEvents.push({
        workspace_id,
        text: `Customer Folder linked to Drive: ${row.folder_name}`,
        created_by: email,
        action_kind: "customer_folder_sweep_applied",
        metadata: {
          folder_id: row.folder_id,
          folder_url: row.folder_url,
        },
      });
    } catch (e) {
      failed++;
      errors.push({
        folder_id: row.folder_id,
        workspace_id,
        error: e instanceof Error ? e.message : "HubSpot PATCH failed",
      });
    }
  }

  await saveSweepState(state);
  if (auditEvents.length > 0) {
    // Best-effort audit trail. Failure here doesn't roll back the
    // HubSpot write — the paper trail is nice-to-have.
    try {
      await appendActionLog(auditEvents);
    } catch (e) {
      console.warn("[customer-folders/apply] action_log write failed", {
        error: e instanceof Error ? e.message : e,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    applied,
    skipped_already_set,
    failed,
    errors: errors.slice(0, 20),
  });
}
