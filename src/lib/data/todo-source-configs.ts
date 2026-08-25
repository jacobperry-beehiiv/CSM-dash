import { kvGet, kvSet } from "../storage/kv";
import type {
  TodoSourceConfigsBlob,
  TodoSourceConfig,
  AutomatedSource,
} from "./todo-source-configs-types";
import {
  DEFAULT_TODO_SOURCE_CONFIGS,
  mergeTodoSourceConfigs,
} from "./todo-source-configs-types";

/**
 * Server-only KV store for admin-editable phrasing + action bindings
 * on automated todos. Same posture as wins-config: no module-level
 * cache — warm-isolate could serve a stale phrasing/binding after an
 * admin save. Reads are cheap (single-blob).
 */

const KEY = "csm:todo-source-configs:v1";

export async function loadTodoSourceConfigsBlob(): Promise<TodoSourceConfigsBlob | null> {
  return (await kvGet<TodoSourceConfigsBlob>(KEY)) ?? null;
}

export async function loadEffectiveTodoSourceConfigs(): Promise<
  Record<AutomatedSource, TodoSourceConfig>
> {
  const blob = await loadTodoSourceConfigsBlob();
  return mergeTodoSourceConfigs(blob);
}

export async function saveTodoSourceConfigsBlob(
  blob: TodoSourceConfigsBlob
): Promise<void> {
  await kvSet(KEY, {
    ...blob,
    updated_at: new Date().toISOString(),
  });
}

/** Convenience for engines that only care about one source. Reads
 *  the whole blob once — cheap enough at KV-level; caller can lift
 *  loadEffectiveTodoSourceConfigs above the loop if they're firing
 *  many todos in one sweep. */
export async function getConfigForSource(
  source: AutomatedSource
): Promise<TodoSourceConfig> {
  const cfg = await loadEffectiveTodoSourceConfigs();
  return cfg[source];
}

// ─── Render helper ───────────────────────────────────────────────────────
//
// Kept in the same server-only file so engines that already import
// `getConfigForSource` don't need a second import. Client-facing
// components that only need to preview a template use the pure
// `applyTemplate` export below.

interface RenderContext {
  company_name?: string | null;
  milestone_days?: number | null;
  prior_stage?: string | null;
  /** For slack_* + scheduled + feature_request sources — the original
   *  message body / step title the engine assembled. Falls through
   *  unchanged when no template merge tag references it. */
  original_text?: string | null;
}

/** Substitute `{{token}}` occurrences with values from `ctx`. Unknown
 *  tokens are left in place so a typo in the settings template
 *  doesn't blank the title. Empty/null values render as an empty
 *  string; the caller can trim if it wants. */
export function applyTemplate(
  template: string,
  ctx: RenderContext
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, key) => {
    const k = key as keyof RenderContext;
    const v = ctx[k];
    if (v == null) return "";
    return String(v);
  });
}

/** Higher-level: pick the config for a source and render its
 *  phrasing_template with the given context. Reads KV once via
 *  loadEffectiveTodoSourceConfigs. Callers firing many todos in one
 *  sweep should hoist the config load and use `applyTemplate`
 *  directly for the per-row substitution. */
export async function renderTodoTitle(
  source: AutomatedSource,
  ctx: RenderContext
): Promise<string> {
  const cfg = await getConfigForSource(source);
  const rendered = applyTemplate(cfg.phrasing_template, ctx);
  // Fallback: if the template rendered to empty (e.g. the source
  // relies on {{original_text}} but the caller didn't pass it), fall
  // back to original_text or a generic string. Never let an empty
  // title reach the panel.
  const trimmed = rendered.trim();
  if (trimmed) return trimmed;
  if (ctx.original_text) return ctx.original_text;
  return "Todo";
}
