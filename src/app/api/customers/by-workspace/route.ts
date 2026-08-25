import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";

/**
 * GET /api/customers/by-workspace?workspace_id=<id>
 *
 * Returns a single Customer row keyed by workspace_id. Used by the
 * personal-todos panel to hydrate an outreach modal when the CSM
 * clicks a todo's "Draft outreach" action button.
 *
 * Session-auth only. Not scoped by CSM — a CSM may click an action
 * button on a todo whose customer isn't on their own book (e.g. an
 * admin-created todo). Returns 404 when the workspace_id doesn't
 * resolve to anything in loadCustomers().
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id")?.trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "Missing workspace_id" },
      { status: 400 }
    );
  }
  const all = await loadCustomers();
  const customer = all.find((c) => c.workspace_id === workspaceId);
  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ customer });
}
