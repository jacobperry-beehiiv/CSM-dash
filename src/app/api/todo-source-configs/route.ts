import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadEffectiveTodoSourceConfigs } from "@/lib/data/todo-source-configs";
import type { TodoAction } from "@/lib/data/todo-source-configs-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/todo-source-configs
 *
 * Public (session-auth) read of the effective todo-source action
 * registry. Used by PersonalTodosPanel to decide whether — and how —
 * to render an action button on each todo. Returns only the fields
 * the panel needs (default_action + action_by_variant), not phrasing
 * templates or admin notes (which are admin-only via
 * /api/settings/todo-source-configs).
 *
 * The Slack `message_template` is intentionally included in the
 * response so the panel could preview it before sending; the endpoint
 * that actually POSTs the Slack message (/api/todo-actions/slack)
 * re-reads the registry server-side so a compromised client can't
 * spray arbitrary channels.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const effective = await loadEffectiveTodoSourceConfigs();
  const bindings: Record<
    string,
    {
      default_action: TodoAction;
      action_by_variant?: Record<string, TodoAction>;
    }
  > = {};
  for (const [source, cfg] of Object.entries(effective)) {
    bindings[source] = {
      default_action: cfg.default_action,
      action_by_variant: cfg.action_by_variant,
    };
  }
  return NextResponse.json({ bindings });
}
