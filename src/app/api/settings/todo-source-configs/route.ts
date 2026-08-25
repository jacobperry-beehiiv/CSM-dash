import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import {
  loadTodoSourceConfigsBlob,
  saveTodoSourceConfigsBlob,
} from "@/lib/data/todo-source-configs";
import {
  AUTOMATED_SOURCES,
  DEFAULT_TODO_SOURCE_CONFIGS,
  type TodoSourceConfig,
  type TodoSourceConfigsBlob,
  type AutomatedSource,
} from "@/lib/data/todo-source-configs-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/todo-source-configs
 *
 * Returns the current overrides + shipped defaults so the settings
 * page can render "your value vs. default" side by side. Admin-gated.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const blob = await loadTodoSourceConfigsBlob();
  return NextResponse.json({
    defaults: DEFAULT_TODO_SOURCE_CONFIGS,
    overrides: blob?.by_source ?? {},
    meta: {
      updated_at: blob?.updated_at ?? null,
      updated_by: blob?.updated_by ?? null,
    },
  });
}

/**
 * PUT /api/settings/todo-source-configs
 *
 * Body: { overrides: Partial<Record<AutomatedSource, TodoSourceConfig>> }
 *
 * Replaces the entire override blob. Any entry whose fields all match
 * the shipped default is stripped so a future default change rolls
 * forward for anyone who hadn't customized that source.
 */
export async function PUT(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: { overrides?: Partial<Record<AutomatedSource, TodoSourceConfig>> } = {};
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload.overrides || typeof payload.overrides !== "object") {
    return NextResponse.json(
      { error: "Missing overrides object" },
      { status: 400 }
    );
  }

  const cleaned: TodoSourceConfigsBlob["by_source"] = {};
  for (const source of AUTOMATED_SOURCES) {
    const override = payload.overrides[source];
    if (!override) continue;
    const defaults = DEFAULT_TODO_SOURCE_CONFIGS[source];
    // Drop the entry entirely if every field matches the default —
    // keeps the blob small and lets a future default change
    // propagate. String equality is fine here; the fields are all
    // scalars.
    const sameTemplate =
      typeof override.phrasing_template === "string" &&
      override.phrasing_template === defaults.phrasing_template;
    const sameLink =
      (override.linked_template_id ?? null) === defaults.linked_template_id;
    const noNote = !override.admin_note?.trim();
    if (sameTemplate && sameLink && noNote) continue;
    cleaned[source] = {
      phrasing_template:
        typeof override.phrasing_template === "string" &&
        override.phrasing_template.trim().length > 0
          ? override.phrasing_template
          : defaults.phrasing_template,
      linked_template_id:
        override.linked_template_id != null &&
        override.linked_template_id !== ""
          ? override.linked_template_id
          : null,
      admin_note: override.admin_note?.trim() || null,
    };
  }

  await saveTodoSourceConfigsBlob({
    by_source: cleaned,
    updated_by: email,
  });
  return NextResponse.json({ ok: true, overrides: cleaned });
}
