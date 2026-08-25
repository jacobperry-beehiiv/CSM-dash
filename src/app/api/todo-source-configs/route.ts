import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadEffectiveTodoSourceConfigs } from "@/lib/data/todo-source-configs";

export const dynamic = "force-dynamic";

/**
 * GET /api/todo-source-configs
 *
 * Public (session-auth) read of the effective todo-source config
 * registry. Used by PersonalTodosPanel to decide whether to render
 * the "Draft outreach" action button on each todo. Returns only what
 * the panel needs — the linked_template_id per source — not phrasing
 * templates or admin notes (which are admin-only via
 * /api/settings/todo-source-configs).
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const effective = await loadEffectiveTodoSourceConfigs();
  // Trim to just what the panel needs.
  const bindings: Record<string, { linked_template_id: string | null }> = {};
  for (const [source, cfg] of Object.entries(effective)) {
    bindings[source] = { linked_template_id: cfg.linked_template_id };
  }
  return NextResponse.json({ bindings });
}
