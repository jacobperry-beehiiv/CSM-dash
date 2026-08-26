import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin, listAdminEmails } from "@/lib/auth/admin";
import { loadAdminFlags, saveAdminFlags } from "@/lib/data/admin-flags";
import { invalidateFeatureFlagsCache } from "@/lib/auth/feature-flags";
import { loadCustomers } from "@/lib/data/load-customers";
import { listConnectedEmails } from "@/lib/data/gmail-token";
import type { AdminFlags } from "@/lib/data/admin-flags-types";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/flags
 *   → { flags, eligible_csms: [{ email, name }] }
 *
 *   The `eligible_csms` list powers the multi-select picker in the
 *   Super Admin UI — only CSMs whose Gmail is connected appear,
 *   matching the personalization eligibility envelope. (Picking a
 *   non-connected CSM in the allowlist would be useless: they can't
 *   personalize anyway.)
 *
 * PUT  /api/admin/flags
 *   body: AdminFlags
 *   → saves the new gate config + busts the in-memory cache so the
 *     next request sees the new state immediately.
 *
 * Auth: signed-in session + must pass `isAdmin`. Non-admins get 403.
 */

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const flags = await loadAdminFlags();
  // Build the picker list: every CSM in the book whose Gmail is
  // connected, PLUS every admin (regardless of Gmail-connection or
  // CSM-assignment). Admins land here because they should always be
  // grantable on a flag — a super-admin who isn't assigned to any
  // customer (e.g. Richard) would otherwise be un-pickable.
  //
  // Dedupe by lowercased email; CSM rows win the name over the
  // admin-fallback display name when both apply.
  const [customers, connected] = await Promise.all([
    loadCustomers(),
    listConnectedEmails(),
  ]);
  const connectedSet = new Set(connected.map((e) => e.toLowerCase()));
  const byEmail = new Map<string, { email: string; name: string }>();
  for (const c of customers) {
    const e = c.customer_success_manager_email?.toLowerCase();
    if (!e || !connectedSet.has(e)) continue;
    if (byEmail.has(e)) continue;
    byEmail.set(e, {
      email: e,
      name: (c.customer_success_manager ?? "").replace(/_/g, " ") || e,
    });
  }
  for (const adminEmail of listAdminEmails()) {
    const key = adminEmail.toLowerCase();
    if (byEmail.has(key)) continue;
    // Fallback display name: the local part, title-cased (so
    // "richard@beehiiv.com" reads "Richard" in the picker).
    const local = key.split("@")[0] ?? key;
    const name =
      local
        .split(/[.\-_]/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ") || key;
    byEmail.set(key, { email: key, name });
  }
  const eligible_csms = Array.from(byEmail.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  return NextResponse.json({ flags, eligible_csms });
}

export async function PUT(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  let body: AdminFlags;
  try {
    body = (await req.json()) as AdminFlags;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const saved = await saveAdminFlags(body);
    invalidateFeatureFlagsCache();
    return NextResponse.json({ flags: saved });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
