"use client";

import { useState } from "react";
import type { ProfileFieldOptions } from "@/lib/data/profile-field-options";

/**
 * Admin editor for the two shared option lists (Prior ESP + Tech
 * Stack). Renders read-only when `canEdit` is false — the page is
 * reachable by any signed-in CSM, but only profile-options admins get
 * the add/remove affordances (and the PUT route enforces the same).
 */
export function ProfileFieldOptionsEditor({
  initial,
  canEdit,
}: {
  initial: ProfileFieldOptions;
  canEdit: boolean;
}) {
  const [priorEsp, setPriorEsp] = useState<string[]>(initial.priorEsp);
  const [techStack, setTechStack] = useState<string[]>(initial.techStack);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch("/api/settings/profile-field-options", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priorEsp, techStack }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      // Adopt the server's sanitized/deduped result so the UI reflects
      // exactly what got stored.
      setPriorEsp((json as ProfileFieldOptions).priorEsp ?? priorEsp);
      setTechStack((json as ProfileFieldOptions).techStack ?? techStack);
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-3 mb-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-lg p-3 mb-3 text-sm text-emerald-800 dark:text-emerald-300">
          {message}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <OptionListEditor
          title="Prior ESP options"
          hint="Newsletter platforms a customer may have migrated from."
          values={priorEsp}
          onChange={setPriorEsp}
          canEdit={canEdit}
        />
        <OptionListEditor
          title="Tech Stack options"
          hint="Tools that sit alongside beehiiv in a customer's stack."
          values={techStack}
          onChange={setTechStack}
          canEdit={canEdit}
        />
      </div>

      {canEdit ? (
        <div className="flex items-center gap-2 mt-4">
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save options"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function OptionListEditor({
  title,
  hint,
  values,
  onChange,
  canEdit,
}: {
  title: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    // Commas are disallowed (they break the /csm filter URL param) — the
    // server strips them too, but reject up-front so the CSM sees why.
    const v = draft.replace(/,/g, " ").trim().replace(/\s+/g, " ");
    if (!v) return;
    if (values.some((o) => o.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }

  function remove(value: string) {
    onChange(values.filter((o) => o !== value));
  }

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-4">
      <h3 className="text-sm font-semibold text-fg mb-1">{title}</h3>
      <p className="text-xs text-muted mb-3">{hint}</p>

      {canEdit ? (
        <div className="flex items-center gap-2 mb-3">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add an option…"
            className="flex-1 px-2 py-1 border border-border-strong rounded-md text-sm bg-surface"
          />
          <button
            onClick={add}
            className="px-3 py-1 text-sm border border-border-strong rounded-md bg-surface hover:bg-canvas"
          >
            Add
          </button>
        </div>
      ) : null}

      {values.length === 0 ? (
        <p className="text-xs text-subtle italic">No options yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <li
              key={v}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border bg-surface-2 text-fg"
            >
              <span>{v}</span>
              {canEdit ? (
                <button
                  onClick={() => remove(v)}
                  className="text-subtle hover:text-red-600"
                  aria-label={`Remove ${v}`}
                  title={`Remove ${v}`}
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
