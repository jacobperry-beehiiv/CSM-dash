import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { csmRoster, loadCustomers } from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";

/**
 * GET /api/csms
 *   → 200 { csms: [{ handle: "Jacob_Perry", email: "jacob.perry@beehiiv.com" }, …] }
 *
 * The CSM roster (handle + email) derived from the customer book.
 * Used by pickers that scope by CSM email rather than handle — e.g.
 * the template editor's "Visible to CSMs" dropdown, whose stored
 * `csm_tags` are emails.
 *
 * `loadCustomers()` is already cached (60s), so this is cheap to call
 * on editor open.
 *
 * Auth: any signed-in @beehiiv.com viewer.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const customers = await loadCustomers();
  return NextResponse.json({ csms: csmRoster(customers) });
}
