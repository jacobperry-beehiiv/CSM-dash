"use client";

import { useMemo, useState } from "react";
import {
  AUTOMATED_SOURCES,
  SLACK_CHANNEL_MSG_MAX_LEN,
  SOURCE_METADATA,
  TODO_OFFSET_DAYS_MAX,
  TODO_OFFSET_DAYS_MIN,
  mergeTagsForSource,
  type AutomatedSource,
  type TodoAction,
  type TodoSourceConfig,
} from "@/lib/data/todo-source-configs-types";

// Kept in sync with SLACK_CHANNEL_ID_RE in slack.ts. Duplicated here
// (not imported) because that module is server-only. Slack channel
// ids start with C/G/D/Z (public / private / DM / archived) and have
// 8+ alphanumeric chars after the prefix.
const SLACK_CHANNEL_ID_RE = /^[CGDZ][A-Z0-9]{8,}$/;

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
        const tags = mergeTagsForSource(meta);
        // Sample context used for the phrasing preview AND the timing
        // preview below. Kept in one place so the fictitious values
        // stay consistent across the card ("Ashton Media" everywhere).
        const sampleRenewal = "2026-11-30";
        const previewCtx: Record<string, string | number | undefined> = {
          company_name: "Ashton Media",
          workspace_name: "Ashton Media",
          csm_name: "Jacob Perry",
          owner_email: "sam@ashtonmedia.co",
          lifecycle_stage: "Live",
          renewal_date: meta.supports_renewal ? sampleRenewal : undefined,
          days_until_renewal: meta.supports_renewal ? 90 : undefined,
          milestone_days: meta.supports_milestone ? 30 : undefined,
          prior_stage: meta.supports_prior_stage ? "Follow Up Sent" : undefined,
          original_text: meta.supports_original_text
            ? "Reach out about ad-network rebate"
            : undefined,
        };
        const preview = applyTemplateInline(cfg.phrasing_template, previewCtx);
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
              <div className="text-[10px] text-muted mt-1 space-y-1">
                <div>
                  Supported merge tags — click to copy:
                </div>
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <button
                      key={tag.token}
                      type="button"
                      title={tag.hint}
                      onClick={() =>
                        void navigator.clipboard?.writeText(`{{${tag.token}}}`)
                      }
                      className="bg-surface-2 hover:bg-surface-3 px-1.5 py-0.5 rounded font-mono text-[10px] text-fg border border-border/60"
                    >
                      {`{{${tag.token}}}`}
                    </button>
                  ))}
                </div>
                <div>
                  Default:{" "}
                  <code className="bg-surface-2 px-1 rounded">
                    {defaults[source].phrasing_template}
                  </code>
                </div>
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
                  Per-stage actions
                </label>
                <p className="text-[10px] text-muted mb-2">
                  Each stage picks its own action — email a template,
                  post to a Slack channel, or leave unset to fall back
                  to the default action below.
                </p>
                <div className="space-y-2.5">
                  {meta.variant_actions.map((v, i) => {
                    const currentAction: TodoAction =
                      cfg.action_by_variant?.[v.key] ?? { kind: "none" };
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
                          <div className="mt-3 mb-1 text-[10px] font-semibold uppercase tracking-wide text-subtle border-b border-border/60 pb-0.5">
                            {v.group}
                          </div>
                        ) : null}
                        <div className="flex items-start gap-2 text-xs">
                          <span
                            className="w-52 pt-1.5 text-subtle truncate"
                            title={v.label}
                          >
                            {v.label}
                          </span>
                          <div className="flex-1">
                            <ActionEditor
                              action={
                                cfg.action_by_variant?.[v.key] ?? null
                              }
                              onChange={(next) => {
                                const map: Record<string, TodoAction> = {
                                  ...(cfg.action_by_variant ?? {}),
                                };
                                if (next == null) {
                                  // "Use default" → clear the variant
                                  // entry so runtime falls back to the
                                  // source's default_action.
                                  delete map[v.key];
                                } else {
                                  // Any TodoAction — including the
                                  // explicit { kind: "none" } "No
                                  // action needed" state — persists
                                  // as-is so the runtime suppresses
                                  // the button even when the default
                                  // would show one.
                                  map[v.key] = next;
                                }
                                setField(source, { action_by_variant: map });
                              }}
                              templateOptions={templateOptions}
                              noActionLabel="No action needed"
                              showUseDefault
                              compact
                            />
                          </div>
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
                  ? "Default action (fallback)"
                  : "Action (optional)"}
              </label>
              <ActionEditor
                action={cfg.default_action ?? { kind: "none" }}
                // Default row never signals fall-through (it IS the
                // fall-through). Coerce null → { kind: "none" } so
                // the persisted shape is always a concrete action.
                onChange={(next) =>
                  setField(source, {
                    default_action: next ?? { kind: "none" },
                  })
                }
                templateOptions={templateOptions}
                noActionLabel="No action needed"
              />
              <div className="text-[10px] text-muted mt-1">
                {meta.variant_actions
                  ? "Used when a stage above doesn't have its own action set."
                  : "When set, todos of this source get an action button that either opens the outreach modal (email) or posts to a Slack channel."}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-fg mb-1">
                Timing overrides
              </div>
              <div className="text-[10px] text-muted mb-2">
                {meta.supports_renewal
                  ? "“Due date” shifts relative to the customer’s renewal date. “Show todo” shifts relative to the moment the milestone fires (i.e. from now). "
                  : "“Due date” shifts relative to whatever anchor the source uses (usually the trigger event). “Show todo” shifts relative to the moment the source fires. "}
                Negative = earlier, 0 = same day, positive = later. Leave
                blank to keep the shipped default.
                {meta.variant_actions
                  ? " Source-level values below act as the fallback when a variant doesn’t have its own override."
                  : ""}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <OffsetInput
                  label={
                    meta.supports_renewal
                      ? "Due date — days from renewal date"
                      : "Due date — days from anchor"
                  }
                  value={cfg.due_offset_days ?? null}
                  onChange={(n) => setField(source, { due_offset_days: n })}
                />
                <OffsetInput
                  label="Show todo — days from when it fires"
                  value={cfg.surface_offset_days ?? null}
                  onChange={(n) => setField(source, { surface_offset_days: n })}
                />
              </div>
              <TimingPreview
                supportsRenewal={!!meta.supports_renewal}
                dueOffset={cfg.due_offset_days ?? null}
                surfaceOffset={cfg.surface_offset_days ?? null}
                renewalYmd={sampleRenewal}
              />
              {meta.variant_actions ? (
                <div className="mt-3 pt-2 border-t border-border/60 space-y-2">
                  <div className="text-[10px] text-muted italic">
                    Per-milestone overrides &mdash; blank falls back to the
                    source-level values above.
                  </div>
                  {meta.variant_actions.map((v) => {
                    const entry = cfg.timing_by_variant?.[v.key] ?? {};
                    return (
                      <div key={v.key} className="space-y-0.5">
                        <div className="text-[11px] font-medium text-fg">
                          When customer is {v.label.replace(/^when /i, "")}
                        </div>
                        <div className="grid grid-cols-[auto_1fr] gap-2 items-center pl-3">
                          <span className="text-[10px] text-muted">
                            Due date &mdash; days from renewal
                          </span>
                          <OffsetInput
                            label=""
                            compact
                            value={entry.due_offset_days ?? null}
                            onChange={(n) =>
                              setField(source, {
                                timing_by_variant: mergeVariantTiming(
                                  cfg.timing_by_variant,
                                  v.key,
                                  { due_offset_days: n }
                                ),
                              })
                            }
                          />
                          <span className="text-[10px] text-muted">
                            Show todo &mdash; days from when it fires
                          </span>
                          <OffsetInput
                            label=""
                            compact
                            value={entry.surface_offset_days ?? null}
                            onChange={(n) =>
                              setField(source, {
                                timing_by_variant: mergeVariantTiming(
                                  cfg.timing_by_variant,
                                  v.key,
                                  { surface_offset_days: n }
                                ),
                              })
                            }
                          />
                        </div>
                        <TimingPreview
                          supportsRenewal={!!meta.supports_renewal}
                          dueOffset={
                            entry.due_offset_days ?? cfg.due_offset_days ?? null
                          }
                          surfaceOffset={
                            entry.surface_offset_days ??
                            cfg.surface_offset_days ??
                            null
                          }
                          renewalYmd={sampleRenewal}
                          indent
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}
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

// ─── Action editor sub-component ─────────────────────────────────────────
//
// One tagged-union input, reused by both the default row (three radios:
// No action / Email / Slack) and the per-variant row (four radios: Use
// default / No action / Email / Slack).
//
// `action: TodoAction | null` — null means "no override, fall back to
// the source's default_action." Only variant rows can legally represent
// that; default rows always pass a non-null action. `showUseDefault`
// controls whether the "Use default" radio is rendered — variant rows
// pass true, default rows leave it off.
//
// The distinction between "Use default" and "No action needed" matters:
//   - Use default        → variant deletes from the map, inherits the
//                          source's default_action at runtime.
//   - No action needed   → variant stores { kind: "none" } explicitly,
//                          suppressing the button even when the default
//                          would have shown one.

interface ActionEditorProps {
  action: TodoAction | null;
  onChange: (next: TodoAction | null) => void;
  templateOptions: TemplateOption[];
  /** Only rendered when `showUseDefault` is true — the label on the
   *  "no action button at all" radio, worded per context. */
  noActionLabel: string;
  /** When true, adds a fourth "Use default" radio at the front and
   *  allows onChange(null) to signal fall-through. */
  showUseDefault?: boolean;
  compact?: boolean;
}

function ActionEditor({
  action,
  onChange,
  templateOptions,
  noActionLabel,
  showUseDefault,
  compact,
}: ActionEditorProps) {
  const kind = action?.kind ?? "use_default";
  const channelValid =
    action?.kind !== "slack" ||
    action.channel_id === "" ||
    SLACK_CHANNEL_ID_RE.test(action.channel_id);

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <div className="flex items-center gap-3 text-xs flex-wrap">
        {showUseDefault ? (
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              checked={action == null}
              onChange={() => onChange(null)}
            />
            <span className="text-subtle">Use default</span>
          </label>
        ) : null}
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            checked={kind === "none"}
            onChange={() => onChange({ kind: "none" })}
          />
          <span className="text-subtle">{noActionLabel}</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            checked={kind === "email"}
            onChange={() =>
              onChange({
                kind: "email",
                template_id:
                  action?.kind === "email" ? action.template_id : "",
              })
            }
          />
          <span>✉︎ Email</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            checked={kind === "slack"}
            onChange={() =>
              onChange({
                kind: "slack",
                channel_id:
                  action?.kind === "slack" ? action.channel_id : "",
                message_template:
                  action?.kind === "slack" ? action.message_template : "",
              })
            }
          />
          <span>📣 Slack</span>
        </label>
      </div>

      {action?.kind === "email" ? (
        <select
          className="w-full text-sm px-2 py-1 rounded border border-border bg-surface"
          value={action.template_id}
          onChange={(e) =>
            onChange({ kind: "email", template_id: e.currentTarget.value })
          }
        >
          <option value="">— pick a template —</option>
          {templateOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      ) : null}

      {action?.kind === "slack" ? (
        <div className="space-y-1.5">
          <div>
            <input
              type="text"
              className={`w-full text-sm px-2 py-1 rounded border bg-surface font-mono ${
                channelValid ? "border-border" : "border-red-400 dark:border-red-500/50"
              }`}
              value={action.channel_id}
              onChange={(e) =>
                onChange({
                  ...action,
                  channel_id: e.currentTarget.value.trim(),
                })
              }
              placeholder="C0ABC12345"
              aria-invalid={!channelValid}
              spellCheck={false}
            />
            {!channelValid ? (
              <div className="text-[10px] text-red-700 dark:text-red-300 mt-0.5">
                Slack channel id must look like <code>C0ABC12345</code>
                (starts with C/G/D, all uppercase alphanumeric).
              </div>
            ) : (
              <div className="text-[10px] text-muted mt-0.5">
                Slack channel id — find it via <em>View channel details →
                About</em> in Slack. The bot must be a member of the
                channel.
              </div>
            )}
          </div>
          <div>
            <textarea
              className="w-full text-sm px-2 py-1 rounded border border-border bg-surface font-mono resize-y [field-sizing:content]"
              rows={2}
              value={action.message_template}
              maxLength={SLACK_CHANNEL_MSG_MAX_LEN}
              onChange={(e) =>
                onChange({
                  ...action,
                  message_template: e.currentTarget.value,
                })
              }
              placeholder="Kicking off renewal for {{company_name}} — 30 days out. cc @{{csm_slack_id}}"
            />
            <div className="text-[10px] text-muted mt-0.5">
              Supports the same merge tags as the phrasing template
              above, plus <code>{"{{workspace_url}}"}</code> for a deep
              link back to the customer detail.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Timing preview ──────────────────────────────────────────────────────
//
// Renders the resolved due-date and show-day using a fixed sample
// renewal (2026-11-30) so the admin can see exactly what their offsets
// evaluate to. Kept purely presentational — computes dates in-place so
// the editor stays a single-file component.

interface TimingPreviewProps {
  supportsRenewal: boolean;
  dueOffset: number | null;
  surfaceOffset: number | null;
  renewalYmd: string;
  /** When true, indent the preview to sit under a variant row's
   *  inputs. Source-level previews stay flush. */
  indent?: boolean;
}

function TimingPreview({
  supportsRenewal,
  dueOffset,
  surfaceOffset,
  renewalYmd,
  indent,
}: TimingPreviewProps) {
  // Blank offsets both = engine default, so there's nothing worth
  // previewing. Skip the render to keep the card tight.
  if (dueOffset == null && surfaceOffset == null) return null;

  // Resolve due date: for renewal-anchored sources, shift the sample
  // renewal date; for other sources, shift "today" (the moment the
  // source fires). Same math via shiftYmdDays.
  const anchorYmd = supportsRenewal ? renewalYmd : todayYmd();
  const due =
    dueOffset != null ? formatYmd(shiftYmdDays(anchorYmd, dueOffset)) : "engine default";
  // Surface anchor is always "the moment the source fires" == today
  // in the preview. Negative offsets clamp to "immediately" because
  // we can't surface in the past.
  let surface: string;
  if (surfaceOffset == null) surface = "engine default (immediately)";
  else if (surfaceOffset <= 0) surface = "immediately";
  else surface = formatYmd(shiftYmdDays(todayYmd(), surfaceOffset));

  return (
    <div
      className={`text-[10px] mt-1 italic text-muted ${
        indent ? "pl-3" : ""
      }`}
    >
      Preview{supportsRenewal ? ` (renewal ${formatYmd(renewalYmd)})` : ""}:
      due <span className="text-fg not-italic">{due}</span>, appears{" "}
      <span className="text-fg not-italic">{surface}</span>.
    </div>
  );
}

function todayYmd(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function shiftYmdDays(baseYmd: string, days: number): string {
  const d = new Date(`${baseYmd}T00:00:00Z`);
  if (isNaN(d.getTime())) return baseYmd;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatYmd(ymd: string): string {
  // Human-friendly rendering matches the rest of the app's date
  // formatting (see components/format.ts) — but that helper is
  // typed against nullable date-ish input, and we already know we
  // have a valid YMD. Just render as "Nov 30, 2026".
  const d = new Date(`${ymd}T00:00:00Z`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ─── Offset input ────────────────────────────────────────────────────────
//
// Integer field for `due_offset_days` / `surface_offset_days`. Blank
// (parsed as null) means "engine default"; a signed integer means an
// explicit override, clamped by the API to the registry's bounds
// (TODO_OFFSET_DAYS_MIN..MAX). Compact mode drops the visible label so
// per-variant rows can pack two inputs onto one line.

interface OffsetInputProps {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  /** When true, hides the label text and shrinks the field width so it
   *  can sit beside a variant label on a single grid row. */
  compact?: boolean;
}

function OffsetInput({ label, value, onChange, compact }: OffsetInputProps) {
  // Hide the label when caller passes empty string — variant rows
  // render their own external label via the grid column to the left.
  const showLabel = label.length > 0;
  return (
    <label
      className={
        compact ? "flex items-center gap-1 text-xs" : "block text-xs"
      }
    >
      {showLabel ? (
        <span
          className={
            compact ? "text-muted" : "block mb-1 text-fg font-medium"
          }
        >
          {label}
        </span>
      ) : null}
      <input
        type="number"
        step={1}
        min={TODO_OFFSET_DAYS_MIN}
        max={TODO_OFFSET_DAYS_MAX}
        value={value ?? ""}
        placeholder="—"
        onChange={(e) => {
          const raw = e.currentTarget.value.trim();
          if (raw === "") {
            onChange(null);
            return;
          }
          const n = Math.floor(Number(raw));
          if (!Number.isFinite(n)) return;
          onChange(n);
        }}
        className={
          compact
            ? "w-16 text-xs px-2 py-1 rounded border border-border bg-surface"
            : "w-full text-sm px-2 py-1 rounded border border-border bg-surface"
        }
      />
    </label>
  );
}

// Immutable patch helper for the per-variant timing map. Setting a
// field to null drops it; when a variant entry ends up empty, the
// entire key gets stripped so the editor's dirty-check treats "no
// override" and "explicit null on every field" as equivalent.
function mergeVariantTiming(
  existing: TodoSourceConfig["timing_by_variant"] | undefined,
  variantKey: string,
  patch: { due_offset_days?: number | null; surface_offset_days?: number | null }
): TodoSourceConfig["timing_by_variant"] {
  const next: NonNullable<TodoSourceConfig["timing_by_variant"]> = {
    ...(existing ?? {}),
  };
  const prev = next[variantKey] ?? {};
  const merged: {
    due_offset_days?: number | null;
    surface_offset_days?: number | null;
  } = { ...prev };
  if ("due_offset_days" in patch) {
    if (patch.due_offset_days == null) delete merged.due_offset_days;
    else merged.due_offset_days = patch.due_offset_days;
  }
  if ("surface_offset_days" in patch) {
    if (patch.surface_offset_days == null) delete merged.surface_offset_days;
    else merged.surface_offset_days = patch.surface_offset_days;
  }
  const hasAny =
    merged.due_offset_days != null || merged.surface_offset_days != null;
  if (hasAny) {
    next[variantKey] = merged;
  } else {
    delete next[variantKey];
  }
  return next;
}

