import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  loadCustomers,
  invalidateCustomerCache,
} from "@/lib/data/load-customers";
import {
  loadOverrides,
  setOverride,
} from "@/lib/data/customer-overrides";
import { fetchHubspotCompanyOwners } from "@/lib/integrations/hubspot";

export const dynamic = "force-dynamic";
// Sweep ~3K customers can issue ~30 batch reads + ~50 owner lookups.
// Comfortably under 90s; the explicit cap keeps Vercel from killing
// it mid-flight.
export const maxDuration = 300;

/**
 * POST /api/customer-overrides/refresh-all-csms
 *
 * Sweep every customer in the dashboard's book, pull their HubSpot
 * owner via the existing HubSpot integration, and write a
 * customer-overrides entry for any row whose HubSpot CSM differs
 * from what Metabase last surfaced. The override layer already
 * wins at render time (see applyOverride in customer-overrides.ts +
 * loadCustomers's apply step), so a single sweep brings the whole
 * dashboard in line with HubSpot truth without touching the nightly
 * snapshot pipeline.
 *
 * Body: optional `{ dry_run?: boolean }`. Dry runs return the same
 * diff without persisting overrides — useful for previewing how
 * many rows would change before committing.
 *
 * Response:
 *   {
 *     scanned: number,
 *     changed: number,
 *     unchanged: number,
 *     no_hubspot_company_id: number,
 *     no_owner_in_hubspot: number,
 *     changes: Array<{
 *       workspace_id, company_name,
 *       before: { csm, email },
 *       after:  { csm, email, owner_name }
 *     }>,
 *     dry_run: boolean,
 *   }
 *
 * Auth: NextAuth session (any signed-in CSM). The audit trail on the
 * override (`csm_refreshed_by`) carries the viewer's email so future
 * forensics can tell who triggered the sweep.
 */

interface PostBody {
  dry_run?: boolean;
}

interface ChangeRow {
  workspace_id: string;
  company_name: string | null;
  before: { csm: string | null; email: string | null };
  after: { csm: string | null; email: string | null; owner_name: string | null };
}

/** Mirror the snake_case convention from the per-row refresh endpoint
 *  so a bulk sweep produces the same identifier shape (e.g.
 *  `olivia.chen@beehiiv.com` → `olivia_chen`). */
function ownerEmailToCsmId(email: string): string {
  const localPart = email.split("@", 1)[0] ?? email;
  return localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
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

  let body: PostBody = {};
  try {
    if (req.headers.get("content-length")) {
      body = (await req.json()) as PostBody;
    }
  } catch {
    // Empty / non-JSON body is fine — treat as default options.
  }
  const dryRun = Boolean(body.dry_run);

  // Load every customer + the current overrides snapshot so we can
  // diff what we'd be writing.
  const customers = await loadCustomers();
  const overrides = await loadOverrides();

  // Collect every company_id we can look up. Customers without one
  // are tracked separately so the response can say how many rows
  // were unreachable.
  const idsToLookup: string[] = [];
  const companyToCustomer = new Map<string, (typeof customers)[number]>();
  let noHubspotCompanyId = 0;
  for (const c of customers) {
    if (!c.workspace_id) continue;
    if (!c.hubspot_company_id) {
      noHubspotCompanyId++;
      continue;
    }
    idsToLookup.push(c.hubspot_company_id);
    companyToCustomer.set(c.hubspot_company_id, c);
  }

  let ownerMap: Awaited<ReturnType<typeof fetchHubspotCompanyOwners>>;
  try {
    ownerMap = await fetchHubspotCompanyOwners(idsToLookup);
  } catch (e) {
    return NextResponse.json(
      {
        error: `HubSpot batch fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 502 }
    );
  }

  const changes: ChangeRow[] = [];
  let noOwnerInHubspot = 0;
  let unchanged = 0;
  const nowIso = new Date().toISOString();

  for (const [companyId, owner] of ownerMap) {
    const customer = companyToCustomer.get(companyId);
    if (!customer || !customer.workspace_id) continue;
    if (!owner) {
      // hubspot_owner_id was unset OR the owner lookup failed. Leave
      // the snapshot value alone — keeping the stale-but-known CSM
      // beats overwriting it with "unassigned".
      noOwnerInHubspot++;
      continue;
    }

    // Compare against the live dashboard value (snapshot + any
    // existing override). The per-row refresh writes the email
    // override too, so we use it as the diff anchor.
    const currentEmail =
      customer.customer_success_manager_email?.toLowerCase() ?? null;
    if (currentEmail === owner.owner_email) {
      unchanged++;
      continue;
    }

    const csmId = ownerEmailToCsmId(owner.owner_email);
    changes.push({
      workspace_id: customer.workspace_id,
      company_name: customer.company_name ?? customer.workspace_name ?? null,
      before: {
        csm: customer.customer_success_manager ?? null,
        email: customer.customer_success_manager_email ?? null,
      },
      after: {
        csm: csmId,
        email: owner.owner_email,
        owner_name: owner.owner_name,
      },
    });

    if (!dryRun) {
      // Reuse the existing per-field override so per-row refreshes,
      // bulk sweeps, and future webhook flows all converge on the
      // same shape. `setOverride` does its own read-modify-write so
      // running the sweep in parallel with someone clicking a
      // single-row refresh is safe.
      await setOverride(customer.workspace_id, {
        customer_success_manager: csmId,
        customer_success_manager_email: owner.owner_email,
        csm_refreshed_at: nowIso,
        csm_refreshed_by: viewer,
      });
    }
  }

  if (!dryRun && changes.length > 0) {
    // Bust the loadCustomers cache so the next dashboard render
    // picks up every override we just wrote in one shot.
    invalidateCustomerCache();
  }

  return NextResponse.json({
    scanned: customers.length,
    changed: changes.length,
    unchanged,
    no_hubspot_company_id: noHubspotCompanyId,
    no_owner_in_hubspot: noOwnerInHubspot,
    // Don't blast 3K rows of diff back in the response — cap at 200
    // so the toast can show a useful sample without a 1MB body.
    changes: changes.slice(0, 200),
    truncated: changes.length > 200,
    dry_run: dryRun,
    overrides_total: Object.keys(overrides).length,
  });
}
