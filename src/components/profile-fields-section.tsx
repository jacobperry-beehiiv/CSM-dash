"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MultiSelectFilter } from "./filters";
import { techStackChoices } from "@/lib/data/profile-field-options-types";

/**
 * The three CSM-owned stack fields — Tech Stack, Prior ESP, and
 * free-text Tech Stack Notes — as a self-contained block of label/value
 * rows.
 *
 * Rendered in TWO places, which is the whole point of the component:
 *   1. CustomerDetailPanel → "Tech & Prior ESP" section, so it reaches
 *      the expanded row in All Assigned *and* every other surface that
 *      renders that panel (at-risk, AM past-due / renewals, …).
 *   2. /account/[id] → in place of the old standalone Profile card.
 * Those two surfaces share no layout code, so the rows are rendered
 * here rather than through either one's local <Row> helper.
 *
 * All three fields are override-only: they never come from Metabase or
 * HubSpot, so they save to /api/customer-overrides and survive the
 * twice-daily snapshot refresh.
 *
 * Each save posts ONLY the field being edited, so a request never
 * blanks its siblings by omission (the route keys off `"field" in
 * body`). That is a narrower guarantee than it sounds: setOverride() is
 * a read-modify-write of the whole customer-overrides KV blob with no
 * locking, so two saves fired inside the same round-trip can still lose
 * one. That's the pre-existing store-level gotcha documented in
 * CLAUDE.md, unchanged by this component — three Save buttons just make
 * it easier to reach than the old single combined POST did. Save one
 * field at a time.
 *
 * Option lists are fetched client-side rather than passed in. This
 * component mounts inside CustomerDetailPanel, which is rendered from
 * nine different call sites — most of which have no access to the
 * server-only loadProfileFieldOptions(). See the shared loader below
 * for why that isn't nine requests.
 */

interface Props {
  workspaceId: string | null | undefined;
  priorEsp: string[] | null | undefined;
  techStack: string[] | null | undefined;
  techStackNotes: string | null | undefined;
}

// ─── Shared options loader ─────────────────────────────────────────
// Same shape as loadFieldMappingsShared() in mapped-field-editor.tsx,
// and for the same reason: a table with several rows expanded mounts
// one of these per row, and the browser doesn't dedupe concurrent
// in-flight fetches (only cached responses). One shared promise plus a
// short-TTL memo means a page-full of panels costs a single
// round-trip. The lists are admin-managed and change rarely, so TTL
// staleness is a non-issue — an admin's edit at
// /settings/profile-fields lands on the next reload.
interface OptionsState {
  priorEsp: string[];
  techStack: string[];
}
const OPTIONS_TTL_MS = 30_000;
let optionsMemo: { at: number; data: OptionsState } | null = null;
let optionsInFlight: Promise<OptionsState> | null = null;

function loadProfileOptionsShared(): Promise<OptionsState> {
  if (optionsMemo && Date.now() - optionsMemo.at < OPTIONS_TTL_MS) {
    return Promise.resolve(optionsMemo.data);
  }
  if (optionsInFlight) return optionsInFlight;
  optionsInFlight = fetch("/api/settings/profile-field-options")
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Partial<OptionsState>;
      const data: OptionsState = {
        priorEsp: Array.isArray(j.priorEsp) ? j.priorEsp : [],
        techStack: Array.isArray(j.techStack) ? j.techStack : [],
      };
      optionsMemo = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      // Clear the handle either way, so a failed load (which leaves the
      // memo empty) retries on the next mount instead of being wedged
      // behind a rejected promise.
      optionsInFlight = null;
    });
  return optionsInFlight;
}

export function ProfileFieldsSection({
  workspaceId,
  priorEsp,
  techStack,
  techStackNotes,
}: Props) {
  const [options, setOptions] = useState<OptionsState | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadProfileOptionsShared()
      .then((o) => {
        if (!cancelled) setOptions(o);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Fall back to empty lists so the saved values still render and
        // stay removable — but SURFACE the failure. Silently showing an
        // empty picker reads as "an admin wiped the option list", when
        // the usual cause is an expired session 401ing the GET.
        setOptions({ priorEsp: [], techStack: [] });
        setOptionsError(
          e instanceof Error ? e.message : "Couldn't load the option lists"
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <MultiSelectRow
        label="Tech Stack"
        field="tech_stack"
        values={techStack}
        // Tech Stack offers its own options PLUS every Prior ESP name —
        // customers often keep the old ESP running alongside beehiiv.
        // The two fields stay separate; only the choices are widened.
        options={options ? techStackChoices(options) : []}
        optionsLoading={options === null}
        optionsError={optionsError}
        workspaceId={workspaceId}
      />
      <MultiSelectRow
        label="Prior ESP"
        field="prior_esp"
        values={priorEsp}
        options={options?.priorEsp ?? []}
        optionsLoading={options === null}
        optionsError={optionsError}
        workspaceId={workspaceId}
      />
      <NotesRow value={techStackNotes} workspaceId={workspaceId} />
    </>
  );
}

/**
 * Shared save helper. Posts a single field, so the patch touches only
 * that key and can't blank its siblings by omission. See the header
 * comment for what this does NOT protect against (concurrent
 * whole-blob writes).
 */
async function saveOverrideField(
  workspaceId: string,
  field: "prior_esp" | "tech_stack" | "tech_stack_notes",
  value: string[] | string
): Promise<void> {
  const r = await fetch("/api/customer-overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, [field]: value }),
  });
  const json = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
}

/**
 * One multi-select row: chips when idle, the shared MultiSelectFilter
 * checklist when editing. Reuses that component as-is (it's the same
 * editor the account-profile card used) — inside a normal panel section
 * there's no overflow-hidden table cell for its popover to escape.
 */
function MultiSelectRow({
  label,
  field,
  values,
  options,
  optionsLoading,
  optionsError,
  workspaceId,
}: {
  label: string;
  field: "prior_esp" | "tech_stack";
  values: string[] | null | undefined;
  options: string[];
  optionsLoading: boolean;
  /** Non-null when the option lists failed to load — shown inline so an
   *  empty picker isn't mistaken for a cleared admin list. */
  optionsError: string | null;
  workspaceId: string | null | undefined;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = values ?? [];

  // Union of the admin list + anything already selected, so a value an
  // admin has since removed stays visible and toggleable instead of
  // being silently dropped on the next edit.
  const choices = Array.from(
    new Set([...options, ...Array.from(draft), ...current])
  );

  function startEditing() {
    setDraft(new Set(current));
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setDraft(new Set(current));
    setError(null);
    setEditing(false);
  }

  async function save() {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      await saveOverrideField(workspaceId, field, Array.from(draft));
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <RowShell label={label}>
      {editing ? (
        <div className="space-y-2">
          <MultiSelectFilter
            emptyLabel="None selected"
            disableZeroCounts={false}
            options={choices.map((o) => ({ value: o, label: o }))}
            selected={draft}
            onToggle={(value) =>
              setDraft((prev) => {
                const next = new Set(prev);
                if (next.has(value)) next.delete(value);
                else next.add(value);
                return next;
              })
            }
            onClear={() => setDraft(new Set())}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-2 py-0.5 text-xs bg-accent text-accent-fg rounded hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="px-2 py-0.5 text-xs border border-border-strong rounded hover:bg-canvas disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {optionsError ? (
            <p
              className="text-[11px] text-amber-700 dark:text-amber-300"
              title={optionsError}
            >
              ⚠ Couldn&rsquo;t load the option list ({optionsError.slice(0, 40)}
              ) — only the values already saved here are selectable. Reload to
              retry.
            </p>
          ) : null}
          {error ? (
            <p className="text-[11px] text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
          {current.length ? (
            <span className="inline-flex flex-wrap gap-1 justify-end">
              {current.map((v) => (
                <span
                  key={v}
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-xs border border-border bg-surface-2"
                >
                  {v}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-subtle italic">—</span>
          )}
          {workspaceId ? (
            <button
              type="button"
              onClick={startEditing}
              disabled={optionsLoading}
              className="text-[11px] text-accent hover:underline disabled:opacity-50 disabled:no-underline"
              title={
                optionsLoading
                  ? "Loading the option list…"
                  : `Edit ${label} — saved to the dashboard, not HubSpot`
              }
            >
              ✎ Edit
            </button>
          ) : null}
        </div>
      )}
    </RowShell>
  );
}

/**
 * Free-text notes row. Mirrors how Risk detail / Goal detail read and
 * behave in this panel — value on its own line under the label, an
 * "✎ Edit" link that swaps in a textarea with Save / Cancel — but
 * writes to the overrides KV instead of going through
 * MappedFieldEditor, which is gated on a HubSpot field mapping this
 * dashboard-owned field will never have (it would render permanently
 * read-only).
 */
function NotesRow({
  value,
  workspaceId,
}: {
  value: string | null | undefined;
  workspaceId: string | null | undefined;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  // Re-sync when the read-through value changes under us (a sibling
  // edit triggered router.refresh()).
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  // Clear the "Saved." timer on unmount. The panel's Section unmounts
  // its children when collapsed, so collapsing the section (or the
  // expanded table row) within the 3s window would otherwise fire
  // setState on an unmounted component and leak the timer.
  useEffect(
    () => () => {
      if (savedTimer.current !== null) {
        window.clearTimeout(savedTimer.current);
      }
    },
    []
  );

  async function save() {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      // Empty string is the clear signal — the route trims and the
      // store deletes the key.
      await saveOverrideField(workspaceId, "tech_stack_notes", draft.trim());
      setEditing(false);
      setSaved(true);
      savedTimer.current = window.setTimeout(() => setSaved(false), 3000);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <RowShell label="Tech Stack Notes" block>
      {editing ? (
        <div className="space-y-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            rows={3}
            // Mirrors TECH_STACK_NOTES_MAX in the API route, so the
            // server-side cap can never silently truncate what a CSM
            // typed — they hit the limit in the textarea first.
            maxLength={2000}
            placeholder="Anything the dropdowns can't capture — migration timing, what each tool is used for…"
            className="w-full px-2 py-1 text-sm border border-border-strong rounded-md bg-surface text-fg"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-2 py-0.5 text-xs bg-accent text-accent-fg rounded hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(value ?? "");
                setError(null);
              }}
              disabled={saving}
              className="px-2 py-0.5 text-xs border border-border-strong rounded hover:bg-canvas disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {error ? (
            <p className="text-[11px] text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1">
          <div className="text-fg break-words whitespace-pre-wrap leading-relaxed">
            {value?.trim() ? (
              value
            ) : (
              <span className="text-subtle italic">—</span>
            )}
          </div>
          {workspaceId ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-[11px] text-accent hover:underline"
                title="Edit Tech Stack Notes — saved to the dashboard, not HubSpot"
              >
                ✎ Edit
              </button>
              {saved ? (
                <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
                  Saved.
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </RowShell>
  );
}

/**
 * Row chrome matching CustomerDetailPanel's local <Row>: inline
 * label/value by default, label-above-value for long-form prose. Kept
 * here (rather than imported) because the panel's helper is private and
 * the /account page's equivalent is a different component — this way
 * both surfaces get identical rows.
 */
function RowShell({
  label,
  children,
  block = false,
}: {
  label: string;
  children: React.ReactNode;
  block?: boolean;
}) {
  const padClass = "py-2 first:pt-0 last:pb-0";
  if (block) {
    return (
      <div className={`text-sm space-y-1.5 ${padClass}`}>
        <dt className="text-muted text-xs uppercase tracking-wide font-medium">
          {label}
        </dt>
        <dd className="text-fg break-words leading-relaxed">{children}</dd>
      </div>
    );
  }
  return (
    <div
      className={`flex justify-between items-baseline gap-4 text-sm ${padClass}`}
    >
      <dt className="text-muted whitespace-nowrap">{label}</dt>
      <dd className="text-fg text-right break-words min-w-0">{children}</dd>
    </div>
  );
}
