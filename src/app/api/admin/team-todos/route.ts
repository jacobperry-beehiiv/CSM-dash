import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { loadAll } from "@/lib/personal-todos/store";
import { loadCustomers } from "@/lib/data/load-customers";
import { todayYmdUtc, isScheduledFor } from "@/lib/personal-todos/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/team-todos
 *   → { users: Array<UserSummary> }
 *
 * Lists every user with at least one todo slice in the personal-todos
 * KV, plus a count breakdown (open / scheduled / completed). Powers
 * the left-pane CSM list on /admin/team-todos.
 *
 * Auth: signed-in admin (see src/lib/auth/admin.ts). Non-admins get
 * 403 — this endpoint never reveals per-user counts to anyone else.
 *
 * Why surface CSMs with zero todos too: the page is also useful for
 * "Mac doesn't have anything on his list yet — let me add one for
 * him", so the picker needs to include every CSM, not just those who
 * already have rows.
 */

interface UserSummary {
  userKey: string;
  /** "Jacob_Perry" — derived from the customer book if the userKey
   *  is an email-shaped key, else null. Used as the display label. */
  csm_handle: string | null;
  email: string | null;
  open_count: number;
  scheduled_count: number;
  completed_count: number;
  total_count: number;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!isAdmin(session.user.email)) {
    return NextResponse.json({ error: "Admin only." }, { status: 403 });
  }

  const [state, customers] = await Promise.all([
    loadAll(),
    loadCustomers(),
  ]);
  const today = todayYmdUtc();

  // userKey is the lowercased CSM email — same convention as
  // userKeyFromEmail() in personal-todos/identity.ts. Both the
  // dashboard (NextAuth session email) and the Slack webhook
  // (slack id → email via the resolution chain) write to that
  // shape, so it's the single source of truth.
  //
  // The customer book gives us:
  //   • the canonical set of CSM emails (filter — anything else is
  //     a non-CSM whose todo bucket exists by mistake; see #N below)
  //   • email → CSM handle (display label "Jacob_Perry" → "Jacob Perry")
  const csmEmails = new Set<string>();
  const emailToHandle = new Map<string, string>();
  for (const c of customers) {
    const e = c.customer_success_manager_email?.trim().toLowerCase();
    if (!e) continue;
    csmEmails.add(e);
    if (c.customer_success_manager) {
      emailToHandle.set(e, c.customer_success_manager);
    }
  }

  // Collect userKeys from:
  //   1. Existing todo buckets in KV.
  //   2. Every CSM in the book (so an admin can seed a fresh todo
  //      for a CSM whose slice doesn't exist yet).
  // Both sources contribute bare-email keys — Set dedupes them.
  // We then filter to csmEmails, dropping todo buckets that
  // accumulated for non-CSMs (Tyler, Kanishka, etc.). Their
  // existing rows remain in KV (no data loss); they're just hidden
  // from the admin display. Future Slack writes are blocked at the
  // resolver (see identity.ts).
  const userKeys = new Set<string>(Object.keys(state.by_user));
  for (const e of csmEmails) userKeys.add(e);

  const users: UserSummary[] = [];
  for (const userKey of userKeys) {
    if (!csmEmails.has(userKey)) continue; // skip non-CSM buckets
    const todos = state.by_user[userKey]?.todos ?? [];
    let openCount = 0;
    let scheduledCount = 0;
    let completedCount = 0;
    for (const t of todos) {
      if (t.completed_at) {
        completedCount++;
        continue;
      }
      if (isScheduledFor(t, today)) {
        scheduledCount++;
      } else {
        openCount++;
      }
    }
    users.push({
      userKey,
      csm_handle: emailToHandle.get(userKey) ?? null,
      email: userKey,
      open_count: openCount,
      scheduled_count: scheduledCount,
      completed_count: completedCount,
      total_count: todos.length,
    });
  }

  // Sort: CSMs with the most open todos first (most actionable for
  // the admin); ties broken by handle alphabetic.
  users.sort((a, b) => {
    if (a.open_count !== b.open_count) return b.open_count - a.open_count;
    const ah = a.csm_handle ?? a.userKey;
    const bh = b.csm_handle ?? b.userKey;
    return ah.localeCompare(bh);
  });

  return NextResponse.json({ users });
}
