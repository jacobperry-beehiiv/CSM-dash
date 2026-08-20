"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MultiSelectFilter } from "./filters";

/**
 * Account-profile card for the two override-backed CSM fields:
 * "Prior ESP" and "Tech Stack" — both multi-select (a customer can have
 * migrated from more than one ESP and use several tools). Any signed-in
 * CSM can edit; both save in one POST to /api/customer-overrides, then
 * router.refresh() re-renders the server component against the new
 * override values.
 *
 * The selectable choices come from the admin-managed lists passed in as
 * props. A previously-saved value that's no longer in the list (an
 * admin removed it) is still shown and kept selected so editing doesn't
 * silently drop it.
 */
export function AccountProfileFields({
  workspaceId,
  priorEsp,
  techStack,
  priorEspOptions,
  techStackOptions,
}: {
  workspaceId: string | null;
  priorEsp: string[] | null;
  techStack: string[] | null;
  priorEspOptions: string[];
  techStackOptions: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [espDraft, setEspDraft] = useState<Set<string>>(
    new Set(priorEsp ?? [])
  );
  const [stackDraft, setStackDraft] = useState<Set<string>>(
    new Set(techStack ?? [])
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEdit = Boolean(workspaceId);
  const currentEsp = priorEsp ?? [];
  const currentStack = techStack ?? [];

  // Union of the admin list + any already-selected value not in it, so
  // orphaned selections remain visible/toggleable while editing.
  const espChoices = Array.from(
    new Set([...priorEspOptions, ...Array.from(espDraft)])
  );
  const stackChoices = Array.from(
    new Set([...techStackOptions, ...Array.from(stackDraft)])
  );

  function toggleEsp(value: string) {
    setEspDraft((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function toggleStack(value: string) {
    setStackDraft((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function cancel() {
    setEspDraft(new Set(priorEsp ?? []));
    setStackDraft(new Set(techStack ?? []));
    setError(null);
    setEditing(false);
  }

  async function save() {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/customer-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          prior_esp: Array.from(espDraft),
          tech_stack: Array.from(stackDraft),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-surface rounded-xl border border-border shadow-card p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-fg">Profile</h3>
        {canEdit && !editing ? (
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-muted hover:text-fg underline decoration-dotted"
          >
            ✎ Edit
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="mb-2 text-xs text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md px-2 py-1">
          {error}
        </div>
      ) : null}

      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-muted mb-1">Prior ESP</label>
            <MultiSelectFilter
              emptyLabel="None selected"
              disableZeroCounts={false}
              options={espChoices.map((o) => ({ value: o, label: o }))}
              selected={espDraft}
              onToggle={toggleEsp}
              onClear={() => setEspDraft(new Set())}
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Tech Stack</label>
            <MultiSelectFilter
              emptyLabel="None selected"
              disableZeroCounts={false}
              options={stackChoices.map((o) => ({ value: o, label: o }))}
              selected={stackDraft}
              onToggle={toggleStack}
              onClear={() => setStackDraft(new Set())}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1 text-xs bg-accent text-accent-fg rounded-md hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={cancel}
              disabled={saving}
              className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <dl className="space-y-1.5">
          <div className="flex justify-between gap-4 text-sm">
            <dt className="text-muted whitespace-nowrap">Prior ESP</dt>
            <dd className="text-fg text-right">
              {currentEsp.length ? (
                <div className="flex flex-wrap gap-1 justify-end">
                  {currentEsp.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-xs border border-border bg-surface-2"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-4 text-sm">
            <dt className="text-muted whitespace-nowrap">Tech Stack</dt>
            <dd className="text-fg text-right">
              {currentStack.length ? (
                <div className="flex flex-wrap gap-1 justify-end">
                  {currentStack.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-xs border border-border bg-surface-2"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
