import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadCustomers } from "@/lib/data/load-customers";
import { applyTodoOps } from "@/lib/personal-todos/store";
import { newTodoId, type PersonalTodo } from "@/lib/personal-todos/types";
import { userKeyFromEmail } from "@/lib/personal-todos/identity";

export const dynamic = "force-dynamic";

/**
 * POST /api/personal-todos/bulk-create-for-csms
 *
 * Body: { todos: Array<{ csm_handle: string, title: string,
 *                       details?: string, due_date?: string }> }
 *
 * Creates one personal todo per (csm_handle, title) pair, owned by
 * the CSM whose handle matches. Used by the "📣 Slack per CSM" flow
 * in the AM tabs — when a CSM gets a roll-up ping ("you have 5
 * past-due accounts to review"), we also drop a todo on their
 * personal list so it shows up in their home-page checklist next
 * time they open the dash.
 *
 * Lookup: handle → email via the customer book
 * (Customer.customer_success_manager == handle →
 *  Customer.customer_success_manager_email). Same bridge the inbound
 *  Slack webhook uses, just the opposite direction. CSMs without an
 *  email in q10600 (new hires, etc.) are reported back as failures so
 *  the caller can surface them without aborting the whole batch.
 *
 * Auth: any signed-in @beehiiv.com viewer. The endpoint is
 * write-on-behalf-of intentionally — the dashboard's roll-up Slack
 * flow needs to create todos for teammates, not just the caller.
 */

interface TodoSpec {
  csm_handle?: string;
  title?: string;
  details?: string | null;
  due_date?: string | null;
}

interface BulkBody {
  todos?: TodoSpec[];
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const specs = Array.isArray(body.todos) ? body.todos : [];
  if (specs.length === 0) {
    return NextResponse.json(
      { error: "Body must include a non-empty `todos` array" },
      { status: 400 }
    );
  }

  // Build a handle → email index from the customer book. Case-flexible
  // match so "Jacob_Perry" / "jacob_perry" / "Jacob Perry" all resolve
  // to the same row. Skips Customers with no email (new hires, etc.).
  const customers = await loadCustomers();
  const handleToEmail = new Map<string, string>();
  for (const c of customers) {
    const h = c.customer_success_manager;
    if (!h) continue;
    if (!c.customer_success_manager_email) continue;
    const key = h.trim().toLowerCase();
    if (!handleToEmail.has(key)) {
      handleToEmail.set(key, c.customer_success_manager_email);
    }
  }

  // Group todos by user_key so a single applyTodoOps call per CSM
  // does one read-modify-write instead of N. The Slack roll-up flow
  // only sends one todo per CSM anyway, but defensively grouping
  // keeps the endpoint correct for any future caller that batches.
  const todosByUserKey = new Map<string, PersonalTodo[]>();
  const failures: Array<{ csm_handle: string; reason: string }> = [];
  const now = new Date().toISOString();
  for (const s of specs) {
    const handle = (s.csm_handle ?? "").trim();
    const title = (s.title ?? "").trim();
    if (!handle || !title) {
      failures.push({
        csm_handle: handle || "(empty)",
        reason: "csm_handle and title are required",
      });
      continue;
    }
    const email = handleToEmail.get(handle.toLowerCase());
    if (!email) {
      failures.push({
        csm_handle: handle,
        reason:
          "no @beehiiv.com email in the customer book for this handle (CSM may not have any accounts assigned yet)",
      });
      continue;
    }
    const userKey = userKeyFromEmail(email);
    const todo: PersonalTodo = {
      id: newTodoId(),
      title,
      details: s.details ?? null,
      due_date: s.due_date ?? null,
      surface_at: null,
      priority: null,
      source: "slack_dm", // best-fit existing source; reflects "came from a ping"
      source_meta: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    const arr = todosByUserKey.get(userKey) ?? [];
    arr.push(todo);
    todosByUserKey.set(userKey, arr);
  }

  let createdCount = 0;
  for (const [userKey, todos] of todosByUserKey.entries()) {
    try {
      await applyTodoOps(
        userKey,
        todos.map((todo) => ({ type: "add", todo }))
      );
      createdCount += todos.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.error("[bulk-create-for-csms] applyTodoOps failed", {
        userKey,
        count: todos.length,
        error: msg,
      });
      // Re-surface as failures for each affected todo so the caller
      // gets a complete picture of who didn't get a todo.
      for (const todo of todos) {
        failures.push({
          csm_handle: todo.title.slice(0, 40),
          reason: `Failed to write todo: ${msg}`,
        });
      }
    }
  }

  return NextResponse.json({
    created: createdCount,
    failed: failures.length,
    failures,
  });
}
