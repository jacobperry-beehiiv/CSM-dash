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
  SLACK_CHANNEL_MSG_MAX_LEN,
  TODO_OFFSET_DAYS_MAX,
  TODO_OFFSET_DAYS_MIN,
  type TodoSourceConfig,
  type TodoSourceConfigsBlob,
  type TodoAction,
  type AutomatedSource,
} from "@/lib/data/todo-source-configs-types";
import { SLACK_CHANNEL_ID_RE } from "@/lib/integrations/slack";

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

  /** Coerce whatever the client sent for a single action entry into a
   *  valid `TodoAction`, or `null` when the payload is malformed or
   *  represents "no action" (so callers can drop it). Rules:
   *   - `{ kind: "email", template_id }` — template_id must be a
   *     non-empty string; otherwise → null.
   *   - `{ kind: "slack", channel_id, message_template }` — channel_id
   *     must match SLACK_CHANNEL_ID_RE (client-side hint says `C…`);
   *     message_template trimmed non-empty, ≤ MSG_MAX bytes.
   *   - anything else → null.
   *  Server-side coercion keeps the persisted blob well-formed even
   *  if the editor sends a partially-filled row. */
  function normalizeAction(a: unknown): TodoAction | null {
    if (!a || typeof a !== "object") return null;
    const obj = a as Record<string, unknown>;
    if (obj.kind === "none") {
      // "No action needed" — persisted on variants so a runtime
      // resolution suppresses the button even when the source's
      // default_action would show one. Distinct from "no entry in
      // the variant map at all" (which means fall-through).
      return { kind: "none" };
    }
    if (obj.kind === "email") {
      const id = typeof obj.template_id === "string" ? obj.template_id.trim() : "";
      if (!id) return null;
      return { kind: "email", template_id: id };
    }
    if (obj.kind === "slack") {
      const ch = typeof obj.channel_id === "string" ? obj.channel_id.trim() : "";
      const msg =
        typeof obj.message_template === "string"
          ? obj.message_template.trim()
          : "";
      if (!ch || !SLACK_CHANNEL_ID_RE.test(ch)) return null;
      if (!msg) return null;
      // Slack rejects >40k-char posts; we cap well below that so a
      // fat-fingered paste can't blow the KV row size either.
      const trimmedMsg =
        msg.length > SLACK_CHANNEL_MSG_MAX_LEN
          ? msg.slice(0, SLACK_CHANNEL_MSG_MAX_LEN)
          : msg;
      return { kind: "slack", channel_id: ch, message_template: trimmedMsg };
    }
    return null;
  }

  const cleaned: TodoSourceConfigsBlob["by_source"] = {};
  for (const source of AUTOMATED_SOURCES) {
    const override = payload.overrides[source];
    if (!override) continue;
    const defaults = DEFAULT_TODO_SOURCE_CONFIGS[source];

    const normalizedDefault =
      normalizeAction(override.default_action) ?? { kind: "none" };

    // Per-variant map: normalize each entry, drop the null ones so
    // we don't persist "no binding" as an explicit map key. Empty
    // final map is dropped from the persisted shape too.
    const variantActions: Record<string, TodoAction> = {};
    if (
      override.action_by_variant &&
      typeof override.action_by_variant === "object"
    ) {
      for (const [variant, actionRaw] of Object.entries(
        override.action_by_variant
      )) {
        const norm = normalizeAction(actionRaw);
        if (norm) variantActions[variant] = norm;
      }
    }
    const noVariants = Object.keys(variantActions).length === 0;

    // Normalize integer offsets. `null`/absent → "no override";
    // anything else gets parsed, floored, and clamped to the
    // registry's bounds. A NaN or out-of-range value drops silently
    // to null so a fat-fingered save can't schedule a todo years out.
    const normalizeOffset = (raw: unknown): number | null => {
      if (raw === null || raw === undefined || raw === "") return null;
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n)) return null;
      if (n < TODO_OFFSET_DAYS_MIN || n > TODO_OFFSET_DAYS_MAX) return null;
      return n;
    };
    const dueOffset = normalizeOffset(override.due_offset_days);
    const surfaceOffset = normalizeOffset(override.surface_offset_days);

    // Per-variant timing overrides — same shape as actions: drop
    // entries where both fields are null so we don't persist "no
    // override" as an explicit map key.
    const variantTiming: TodoSourceConfig["timing_by_variant"] = {};
    if (
      override.timing_by_variant &&
      typeof override.timing_by_variant === "object"
    ) {
      for (const [variant, raw] of Object.entries(
        override.timing_by_variant as Record<string, unknown>
      )) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as {
          due_offset_days?: unknown;
          surface_offset_days?: unknown;
        };
        const d = normalizeOffset(entry.due_offset_days);
        const s = normalizeOffset(entry.surface_offset_days);
        if (d === null && s === null) continue;
        variantTiming[variant] = {
          ...(d !== null ? { due_offset_days: d } : {}),
          ...(s !== null ? { surface_offset_days: s } : {}),
        };
      }
    }
    const noVariantTiming = Object.keys(variantTiming).length === 0;

    // Drop the entry entirely if every field matches the shipped
    // default. String equality for the phrasing template; deep-ish
    // equality for the default_action (kind + one payload field).
    const sameTemplate =
      typeof override.phrasing_template === "string" &&
      override.phrasing_template === defaults.phrasing_template;
    const sameDefault =
      normalizedDefault.kind === defaults.default_action.kind &&
      normalizedDefault.kind === "none";
    const noNote = !override.admin_note?.trim();
    const noTiming =
      dueOffset === null && surfaceOffset === null && noVariantTiming;
    if (sameTemplate && sameDefault && noNote && noVariants && noTiming)
      continue;

    cleaned[source] = {
      phrasing_template:
        typeof override.phrasing_template === "string" &&
        override.phrasing_template.trim().length > 0
          ? override.phrasing_template
          : defaults.phrasing_template,
      default_action: normalizedDefault,
      action_by_variant: noVariants ? undefined : variantActions,
      admin_note: override.admin_note?.trim() || null,
      ...(dueOffset !== null ? { due_offset_days: dueOffset } : {}),
      ...(surfaceOffset !== null ? { surface_offset_days: surfaceOffset } : {}),
      ...(noVariantTiming ? {} : { timing_by_variant: variantTiming }),
    };
  }

  await saveTodoSourceConfigsBlob({
    by_source: cleaned,
    updated_by: email,
  });
  return NextResponse.json({ ok: true, overrides: cleaned });
}
