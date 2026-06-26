import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isCsmTeamMember } from "@/lib/auth/csm-team";
import { filterCustomers, loadCustomers } from "@/lib/data/load-customers";
import { fetchHubspotOverlayBatch } from "@/lib/integrations/hubspot";
import {
  loadHubspotOverlay,
  saveHubspotOverlay,
  type HubSpotOverlayRow,
} from "@/lib/data/hubspot-overlay";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * POST /api/customers/refresh-hubspot
 *
 * Live HubSpot pull for every customer in the requested CSM scope.
 * Writes a per-workspace overlay row into the shared KV blob; the
 * dashboard's `loadCustomers()` merges those on top of the encrypted
 * snapshot, so changes show up without waiting for the daily sync
 * to regenerate the snapshot.
 *
 * Auth: CSM team only.
 *
 * Query: `?csm=<handle>` to scope to one CSM; absent / `=all` does
 * the team-wide book. Matches the convention used by
 * `/api/news/sweep` + `/api/last-contact/gmail/refresh-book`.
 *
 * Response:
 *   { ok, processed, updated, no_hubspot_company_id, errors,
 *     generated_at }
 */

const MAX_PER_REQUEST = 500;

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isCsmTeamMember(email))) {
    return NextResponse.json(
      { error: "CSM team only" },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const csmParam = (url.searchParams.get("csm") ?? "").trim();
  const csmScope =
    csmParam && csmParam.toLowerCase() !== "all" ? csmParam : null;

  const all = await loadCustomers();
  const scoped = filterCustomers(all, { csm: csmScope });

  const customersWithHubspot = scoped.filter(
    (c): c is typeof c & { workspace_id: string; hubspot_company_id: string } =>
      Boolean(c.workspace_id && c.hubspot_company_id)
  );

  const noHubspot = scoped.length - customersWithHubspot.length;
  if (customersWithHubspot.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      updated: 0,
      no_hubspot_company_id: noHubspot,
      errors: [],
      generated_at: new Date().toISOString(),
      message: "No customers in scope with a HubSpot company link.",
    });
  }

  // Cap per request so a runaway book doesn't burn through HubSpot
  // quota; the helper bats batches internally too.
  const truncated = customersWithHubspot.slice(0, MAX_PER_REQUEST);
  const companyIds = truncated.map((c) => c.hubspot_company_id);
  const companyIdToWorkspaceId = new Map<string, string>();
  for (const c of truncated) {
    companyIdToWorkspaceId.set(c.hubspot_company_id, c.workspace_id);
  }

  console.log("[customers/refresh-hubspot]", {
    requester: email,
    csm: csmScope ?? "(all)",
    in_scope: scoped.length,
    with_hubspot: customersWithHubspot.length,
    no_hubspot: noHubspot,
    processing: truncated.length,
  });

  let hubspotResult;
  try {
    hubspotResult = await fetchHubspotOverlayBatch(companyIds);
  } catch (e) {
    return NextResponse.json(
      {
        error: `HubSpot fetch failed: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      },
      { status: 502 }
    );
  }

  const overlay = await loadHubspotOverlay();
  let updated = 0;
  const errors: Array<{ workspace_id: string; reason: string }> = [];

  for (const [companyId, row] of hubspotResult.entries()) {
    const workspaceId = companyIdToWorkspaceId.get(companyId);
    if (!workspaceId) continue;
    const overlayRow: HubSpotOverlayRow = {
      hubspot_contacts: row.contacts ?? null,
      last_activity_at: row.last_activity_at ?? null,
      last_activity_source: row.source ?? null,
      property_customer_folder: row.customer_folder ?? null,
      fetched_at: new Date().toISOString(),
    };
    overlay.rows[workspaceId] = overlayRow;
    updated++;
  }

  // Customers in scope whose HubSpot company didn't return any data
  // (404, deleted, perm-mismatch) — surface in the response so the
  // UI can hint at follow-up.
  for (const c of truncated) {
    if (!hubspotResult.has(c.hubspot_company_id)) {
      errors.push({
        workspace_id: c.workspace_id,
        reason: `HubSpot returned no data for company ${c.hubspot_company_id}`,
      });
    }
  }

  overlay.fetched_at = new Date().toISOString();
  await saveHubspotOverlay(overlay);

  return NextResponse.json({
    ok: true,
    processed: truncated.length,
    updated,
    no_hubspot_company_id: noHubspot,
    errors,
    truncated: truncated.length < customersWithHubspot.length,
    generated_at: new Date().toISOString(),
  });
}
