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

  // Build a lookup: email → CSM handle. userKey is `email:<lowered>`
  // by convention (see userKeyFromEmail in personal-todos/identity.ts);
  // strip the prefix to recover the email, then look up the handle.
  const emailToHandle = new Map<string, string>();
  for (const c of customers) {
    if (c.customer_success_manager_email && c.customer_success_manager) {
      emailToHandle.set(
        c.customer_success_manager_email.toLowerCase(),
        c.customer_success_manager
      );
    }
  }

  // Collect every userKey we know about — both ones with existing
  // todos AND every CSM in the book (even if they have zero todos
  // yet). That way an admin can add a fresh todo for a CSM whose
  // slice doesn't exist yet.
  const userKeys = new Set<string>(Object.keys(state.by_user));
  for (const c of customers) {
    if (c.customer_success_manager_email) {
      userKeys.add(`email:${c.customer_success_manager_email.toLowerCase()}`);
    }
  }

  const users: UserSummary[] = [];
  for (const userKey of userKeys) {
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
    const email = userKey.startsWith("email:")
      ? userKey.slice("email:".length)
      : null;
    const handle = email ? emailToHandle.get(email) ?? null : null;
    users.push({
      userKey,
      csm_handle: handle,
      email,
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
