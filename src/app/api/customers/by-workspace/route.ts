import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";

/**
 * GET /api/customers/by-workspace?workspace_id=<id>
 *              or ?hubspot_company_id=<id>
 *
 * Returns a single Customer row keyed by workspace_id (preferred) or
 * hubspot_company_id (fallback). Used by the personal-todos panel to
 * hydrate an outreach modal when the CSM clicks a todo's "Draft
 * outreach" action button.
 *
 * The hubspot_company_id path exists because slack_assign onboarding
 * todos only carry hubspot_company_id in source_meta — the todo is
 * spawned by @bot assign before the CSM knows the workspace_id.
 *
 * Session-auth only. Not scoped by CSM — a CSM may click an action
 * button on a todo whose customer isn't on their own book (e.g. an
 * admin-created todo). Returns 404 when neither id resolves to
 * anything in loadCustomers().
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id")?.trim();
  const hubspotCompanyId = url.searchParams
    .get("hubspot_company_id")
    ?.trim();
  if (!workspaceId && !hubspotCompanyId) {
    return NextResponse.json(
      { error: "Missing workspace_id or hubspot_company_id" },
      { status: 400 }
    );
  }
  const all = await loadCustomers();
  const customer = all.find((c) => {
    if (workspaceId && c.workspace_id === workspaceId) return true;
    if (
      hubspotCompanyId &&
      c.hubspot_company_id != null &&
      String(c.hubspot_company_id) === hubspotCompanyId
    ) {
      return true;
    }
    return false;
  });
  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ customer });
}
