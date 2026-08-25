"use client";

import { useMemo, useState } from "react";
import {
  AUTOMATED_SOURCES,
  SOURCE_METADATA,
  type AutomatedSource,
  type TodoSourceConfig,
} from "@/lib/data/todo-source-configs-types";

/**
 * Admin editor for the automated-todo phrasing + action registry.
 * One card per source. Every field falls through to a shipped
 * default when blank so the KV blob stays small and future default
 * changes propagate for un-customized sources.
 */

// The type module doesn't export a client-side template applier
// because renderTodoTitle lives server-side, but we want a preview
// on the settings page. Small inline copy of the substitution logic
// keeps the client bundle from pulling in the KV store module.
export function applyTemplateInline(
  template: string,
  ctx: Record<string, string | number | null | undefined>
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, key) => {
    const v = ctx[key];
    if (v == null) return "";
    return String(v);
  });
}

interface TemplateOption {
  id: string;
  name: string;
}

interface Props {
  defaults: Record<AutomatedSource, TodoSourceConfig>;
  initialOverrides: Partial<Record<AutomatedSource, TodoSourceConfig>>;
  meta: { updated_at: string | null; updated_by: string | null };
  templateOptions: TemplateOption[];
}

export function TodoSourceConfigsEditor({
  defaults,
  initialOverrides,
  meta,
  templateOptions,
}: Props) {
  const [draft, setDraft] = useState<
    Partial<Record<AutomatedSource, TodoSourceConfig>>
  >(initialOverrides);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialOverrides),
    [draft, initialOverrides]
  );

  function effective(source: AutomatedSource): TodoSourceConfig {
    return { ...defaults[source], ...(draft[source] ?? {}) };
  }

  function setField(
    source: AutomatedSource,
    patch: Partial<TodoSourceConfig>
  ) {
    setDraft((prev) => {
      const next = { ...prev };
      const cur: TodoSourceConfig = { ...defaults[source], ...(prev[source] ?? {}), ...patch };
      next[source] = cur;
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch("/api/settings/todo-source-configs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: draft }),
      });
      const body = (await r.json()) as {
        ok?: boolean;
        overrides?: Partial<Record<AutomatedSource, TodoSourceConfig>>;
        error?: string;
      };
      if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`);
      setDraft(body.overrides ?? {});
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {meta.updated_at ? (
        <p className="text-xs text-muted">
          Last saved{" "}
          {new Date(meta.updated_at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          {meta.updated_by ? ` by ${meta.updated_by}` : null}.
        </p>
      ) : (
        <p className="text-xs text-muted italic">
          No overrides on file yet — engines run against shipped defaults.
        </p>
      )}

      {AUTOMATED_SOURCES.map((source) => {
        const cfg = effective(source);
        const meta = SOURCE_METADATA[source];
        const preview = applyTemplateInline(cfg.phrasing_template, {
          company_name: "Ashton Media",
          milestone_days: meta.supports_milestone ? 30 : undefined,
          prior_stage: meta.supports_prior_stage ? "Follow Up Sent" : undefined,
          original_text: meta.supports_original_text
            ? "Reach out about ad-network rebate"
            : undefined,
        });
        const linkedTpl = templateOptions.find(
          (t) => t.id === cfg.linked_template_id
        );

        return (
          <div
            key={source}
            className="border border-border rounded-md bg-surface p-4 space-y-3"
          >
            <div>
              <h3 className="text-sm font-semibold text-fg">
                {meta.label}
              </h3>
              <p className="text-xs text-muted mt-0.5">
                {meta.description}
              </p>
              <code className="mt-1 inline-block text-[10px] bg-surface-2 px-1 py-0.5 rounded text-subtle">
                source: {source}
              </code>
            </div>

            <div>
              <label className="text-xs font-medium text-fg block mb-1">
                Phrasing template
              </label>
              <textarea
                className="w-full text-sm px-2 py-1 rounded border border-border bg-surface font-mono"
                rows={2}
                value={cfg.phrasing_template}
                onChange={(e) =>
                  setField(source, { phrasing_template: e.currentTarget.value })
                }
                placeholder={defaults[source].phrasing_template}
              />
              <div className="text-[10px] text-muted mt-1">
                Supported merge tags:{" "}
                <code className="bg-surface-2 px-1 rounded">
                  {"{{company_name}}"}
                </code>
                {meta.supports_milestone ? (
                  <>
                    ,{" "}
                    <code className="bg-surface-2 px-1 rounded">
                      {"{{milestone_days}}"}
                    </code>
                  </>
                ) : null}
                {meta.supports_prior_stage ? (
                  <>
                    ,{" "}
                    <code className="bg-surface-2 px-1 rounded">
                      {"{{prior_stage}}"}
                    </code>
                  </>
                ) : null}
                {meta.supports_original_text ? (
                  <>
                    ,{" "}
                    <code className="bg-surface-2 px-1 rounded">
                      {"{{original_text}}"}
                    </code>
                  </>
                ) : null}
                . Default:{" "}
                <code className="bg-surface-2 px-1 rounded">
                  {defaults[source].phrasing_template}
                </code>
              </div>
              {preview && preview.trim() !== cfg.phrasing_template.trim() ? (
                <div className="mt-1 text-[10px] text-muted">
                  Preview:{" "}
                  <span className="text-fg font-medium">{preview}</span>
                </div>
              ) : null}
            </div>

            {meta.variant_actions ? (
              <div>
                <label className="text-xs font-medium text-fg block mb-1">
                  Per-stage outreach templates
                </label>
                <p className="text-[10px] text-muted mb-2">
                  Each stage can bind its own template — leave a row unset
                  to fall back to the default template below (or to render
                  no button at all when the default is also empty).
                </p>
                <div className="space-y-1.5">
                  {meta.variant_actions.map((v, i) => {
                    const currentBinding =
                      cfg.linked_template_by_variant?.[v.key] ?? "";
                    // Render a group header only on the first row of
                    // each named group. `variant_actions` is authored
                    // in-order so a change in `group` value between
                    // consecutive rows marks a section boundary.
                    const prevGroup =
                      i > 0 ? meta.variant_actions![i - 1].group : null;
                    const showHeader =
                      v.group != null && v.group !== prevGroup;
                    return (
                      <div key={v.key}>
                        {showHeader ? (
                          <div className="mt-2 mb-1 text-[10px] font-semibold uppercase tracking-wide text-subtle border-b border-border/60 pb-0.5">
                            {v.group}
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2 text-xs">
                          <span className="w-60 text-subtle truncate" title={v.label}>
                            {v.label}
                          </span>
                          <select
                            className="flex-1 text-sm px-2 py-1 rounded border border-border bg-surface"
                            value={currentBinding}
                            onChange={(e) => {
                              const next: Record<string, string | null> = {
                                ...(cfg.linked_template_by_variant ?? {}),
                              };
                              if (e.currentTarget.value) {
                                next[v.key] = e.currentTarget.value;
                              } else {
                                delete next[v.key];
                              }
                              setField(source, {
                                linked_template_by_variant: next,
                              });
                            }}
                          >
                            <option value="">— use default —</option>
                            {templateOptions.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div>
              <label className="text-xs font-medium text-fg block mb-1">
                {meta.variant_actions
                  ? "Default outreach template (fallback)"
                  : "Linked outreach template (optional)"}
              </label>
              <select
                className="w-full text-sm px-2 py-1 rounded border border-border bg-surface"
                value={cfg.linked_template_id ?? ""}
                onChange={(e) =>
                  setField(source, {
                    linked_template_id: e.currentTarget.value || null,
                  })
                }
              >
                <option value="">— no action button —</option>
                {templateOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <div className="text-[10px] text-muted mt-1">
                {meta.variant_actions
                  ? "Used when a stage above doesn't have its own template set."
                  : "When set, todos of this source get a “Draft outreach” button that opens the outreach modal with the customer + this template pre-selected."}
                {linkedTpl ? (
                  <>
                    {" "}Currently linked to <strong>{linkedTpl.name}</strong>.
                  </>
                ) : null}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-fg block mb-1">
                Admin note (why this wiring)
              </label>
              <input
                type="text"
                className="w-full text-sm px-2 py-1 rounded border border-border bg-surface"
                value={cfg.admin_note ?? ""}
                onChange={(e) =>
                  setField(source, { admin_note: e.currentTarget.value })
                }
                placeholder="Free-text — visible to admins only. E.g. 'using T4 pitch template for 90d milestone.'"
              />
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {message ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {message}
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-red-700 dark:text-red-300">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

