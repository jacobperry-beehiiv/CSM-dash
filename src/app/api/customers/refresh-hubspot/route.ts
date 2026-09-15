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

/** Ceiling on customers per request. The underlying helper already
 *  batches at 100/req with HubSpot rate-limit-aware pacing (see
 *  hubspot.ts BATCH_SIZE + INTER_BATCH_DELAY_MS), so this cap exists
 *  only as a runaway-safety valve — not to protect the API from
 *  legitimate team-wide book sizes. Raised from 500 → 5000 after
 *  team-wide resyncs on the /csm page silently truncated books
 *  larger than 500 accounts. 5000 = 50 batches ≈ 5s of pure API
 *  time; the file already sets maxDuration=240 to cover the whole
 *  request including HubSpot pacing delays + KV writes. */
const MAX_PER_REQUEST = 5000;

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
  // Single-workspace diagnostic mode: `?workspace_id=<uuid>&debug=1`
  // scopes the resync to one customer and returns the raw HubSpot
  // batch response + the overlay row that got written. Cuts through
  // "did HubSpot return it?" vs "did the overlay land?" vs "did the
  // merge pick it up?" when a Drive folder set in HubSpot isn't
  // showing on the profile after clicking the header Resync.
  const workspaceIdParam = (url.searchParams.get("workspace_id") ?? "").trim();
  const debug = url.searchParams.get("debug") === "1";

  const all = await loadCustomers();
  const scopedByCsm = filterCustomers(all, { csm: csmScope });
  const scoped = workspaceIdParam
    ? scopedByCsm.filter((c) => c.workspace_id === workspaceIdParam)
    : scopedByCsm;

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
      message: workspaceIdParam
        ? `Workspace ${workspaceIdParam} isn't in the current scope, or has no hubspot_company_id set on the snapshot.`
        : "No customers in scope with a HubSpot company link.",
      debug: debug
        ? {
            workspace_id: workspaceIdParam || null,
            csm_scope: csmScope,
            scope_size: scoped.length,
            snapshot_hubspot_company_id: scoped[0]?.hubspot_company_id ?? null,
          }
        : undefined,
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
      company_engagement: row.company_engagement ?? null,
      property_risk_level: row.property_risk_level ?? null,
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
    /** Pre-cap count of in-scope customers with a HubSpot company
     *  link. Surface it separately from `processed` so the client
     *  can report "processed 4,932 of 5,410" and only flash a
     *  truncation banner when the two disagree. */
    total_with_hubspot: customersWithHubspot.length,
    updated,
    no_hubspot_company_id: noHubspot,
    errors,
    truncated: truncated.length < customersWithHubspot.length,
    generated_at: new Date().toISOString(),
    // Diagnostic block — populated only when the caller passes
    // `?workspace_id=<uuid>&debug=1`. Shows the raw HubSpot batch
    // response for the requested customer alongside the overlay row
    // that got written so a mismatch between "field is live in
    // HubSpot" and "field doesn't render on the profile" can be
    // pinned to the exact hop.
    debug:
      debug && workspaceIdParam
        ? (() => {
            const targetCustomer = truncated.find(
              (c) => c.workspace_id === workspaceIdParam
            );
            const hubspotRow = targetCustomer
              ? hubspotResult.get(targetCustomer.hubspot_company_id)
              : null;
            const overlayRow = overlay.rows[workspaceIdParam] ?? null;
            return {
              workspace_id: workspaceIdParam,
              hubspot_company_id:
                targetCustomer?.hubspot_company_id ?? null,
              hubspot_batch_returned: hubspotRow
                ? {
                    customer_folder: hubspotRow.customer_folder,
                    company_engagement: hubspotRow.company_engagement,
                    property_risk_level: hubspotRow.property_risk_level,
                    last_activity_at: hubspotRow.last_activity_at,
                    last_activity_source: hubspotRow.source,
                    contacts_count: hubspotRow.contacts?.length ?? 0,
                  }
                : null,
              overlay_row_written: overlayRow,
              snapshot_values: {
                property_customer_folder:
                  targetCustomer?.property_customer_folder ?? null,
                company_engagement:
                  targetCustomer?.company_engagement ?? null,
                property_risk_level:
                  targetCustomer?.property_risk_level ?? null,
              },
            };
          })()
        : undefined,
  });
}
