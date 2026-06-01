import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers, invalidateCustomerCache } from "@/lib/data/load-customers";
import {
  loadOverrides,
  setOverride,
  getOverride,
} from "@/lib/data/customer-overrides";
import { fetchHubspotCompanyOwner } from "@/lib/integrations/hubspot";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/customer-overrides/refresh-csm
 *
 * On-demand HubSpot lookup of a single company's owner, written into
 * the customer-overrides KV store so the dashboard reflects HubSpot
 * reassignments without waiting for the next Metabase ETL + nightly
 * snapshot. Triggered from the "🔄 Refresh from HubSpot" button in
 * the customer detail panel's Contact section.
 *
 * Body: `{ workspace_id: string }`
 *
 * Response: `{ before, after }`
 *   - `before`: the CSM the dashboard was showing before this call
 *     (from Metabase + any prior override). Used by the UI to render
 *     "Was: Olivia · Now: Jacob".
 *   - `after`: the CSM we just pulled from HubSpot. `null` when the
 *     company has no owner assigned in HubSpot (we deliberately do
 *     NOT nuke the snapshot value in that case — better to keep the
 *     stale-but-known assignment than show "unassigned").
 *
 * Auth: NextAuth session. The viewer's email is stored on the override
 * as an audit trail (`csm_refreshed_by`).
 */

interface PostBody {
  workspace_id?: string;
}

interface RefreshSnapshot {
  customer_success_manager: string | null;
  customer_success_manager_email: string | null;
}

/** Convert a HubSpot owner email into the snake-cased CSM identifier
 *  the dashboard already uses (q10600's `customer_success_manager`
 *  column). `olivia.chen@beehiiv.com` → `olivia_chen`. Falls back to
 *  the local-part as-is when the email has no dots. */
function ownerEmailToCsmId(email: string): string {
  const localPart = email.split("@", 1)[0] ?? email;
  return localPart.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: "Sign in required." },
      { status: 401 }
    );
  }
  const viewer = session.user.email.toLowerCase();

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON" },
      { status: 400 }
    );
  }
  const workspaceId = body.workspace_id?.trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  // Load the customer (with any prior overrides applied) so we can
  // (a) grab `hubspot_company_id` and (b) return a meaningful `before`
  // diff. loadCustomers() pulls from the same cache the dashboard
  // uses, so this is sub-ms once warm.
  const list = await loadCustomers();
  const customer = list.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json(
      { error: `No customer row found for workspace_id=${workspaceId}` },
      { status: 404 }
    );
  }
  const before: RefreshSnapshot = {
    customer_success_manager: customer.customer_success_manager ?? null,
    customer_success_manager_email:
      customer.customer_success_manager_email ?? null,
  };

  // hubspot_company_id is populated by the sync-time HubSpot enrichment
  // (`scripts/sync.ts`). When it's missing the row never got matched —
  // surface a clear error so the user can fix it in HubSpot or wait
  // for the next nightly sync.
  const companyId = customer.hubspot_company_id?.trim() || null;
  if (!companyId) {
    return NextResponse.json(
      {
        error:
          "Couldn't resolve this workspace to a HubSpot company. The hubspot_company_id is missing on this row — fix the HubSpot match or wait for the next nightly sync.",
      },
      { status: 422 }
    );
  }

  let owner: Awaited<ReturnType<typeof fetchHubspotCompanyOwner>>;
  try {
    owner = await fetchHubspotCompanyOwner(companyId);
  } catch (e) {
    return NextResponse.json(
      {
        error: `HubSpot fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 502 }
    );
  }

  if (!owner) {
    // Company has no owner in HubSpot (unassigned). Don't write a
    // null override — keeping the stale-but-known value beats showing
    // "unassigned" on a row that still has a real CSM in q10600.
    return NextResponse.json(
      {
        before,
        after: null,
        note: "No HubSpot owner assigned for this company. Dashboard value left unchanged.",
      },
      { status: 200 }
    );
  }

  const csmId = ownerEmailToCsmId(owner.owner_email);
  const after: RefreshSnapshot = {
    customer_success_manager: csmId,
    customer_success_manager_email: owner.owner_email,
  };

  // Write the override + invalidate the load-customers cache so the
  // next dashboard render picks up the new value. Matches the
  // invalidation the existing /api/customer-overrides POST does for
  // the interval field.
  await setOverride(workspaceId, {
    customer_success_manager: csmId,
    customer_success_manager_email: owner.owner_email,
    csm_refreshed_at: new Date().toISOString(),
    csm_refreshed_by: viewer,
  });
  invalidateCustomerCache();

  // Re-load the override entry to echo back what's persisted, so the
  // client can show the same `csm_refreshed_at` it'll see on reload.
  const overrides = await loadOverrides();
  const persisted = getOverride(workspaceId, overrides);

  return NextResponse.json({
    before,
    after,
    owner_name: owner.owner_name,
    csm_refreshed_at: persisted?.csm_refreshed_at ?? null,
    csm_refreshed_by: persisted?.csm_refreshed_by ?? null,
  });
}
