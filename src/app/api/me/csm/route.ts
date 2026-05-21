import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  findCsmHandleForViewer,
  loadCustomers,
} from "@/lib/data/load-customers";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/csm
 *   → 200 { csm: "Jacob_Perry" | null }
 *
 * Returns the internal CSM handle owned by the signed-in viewer, or
 * `null` when they aren't a CSM in the current customer book (admins,
 * ex-employees, etc.). The CsmSelector calls this on mount so its
 * default "selected" option matches whatever the page is filtering
 * by server-side.
 *
 * 401 when no session — keeps the lookup gated to authenticated
 * users.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const customers = await loadCustomers();
  const csm = findCsmHandleForViewer(customers, session.user.email);
  return NextResponse.json({ csm });
}
