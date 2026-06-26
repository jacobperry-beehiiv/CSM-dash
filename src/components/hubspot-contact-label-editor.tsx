"use client";

import { useEffect, useState } from "react";
import type { AssociationLabel } from "@/lib/data/hubspot-association-labels";

/**
 * Inline label editor for a single HubSpot contact-company
 * relationship. Shown next to the contact's static info in the
 * customer detail panel. Owns local state for the optimistic
 * update so the parent component doesn't need to know about the
 * write path.
 *
 * Schema (the list of every label HubSpot recognizes for this
 * portal) is lazy-loaded once per page-view via the public endpoint
 * `/api/admin/hubspot-labels` — falls back to inline-editing the
 * existing chips if the schema fetch fails (the API write path
 * will reject unknown labels server-side).
 */
interface Props {
  workspaceId: string;
  contactId: string;
  contactName: string;
  initialLabels: string[];
}

interface SchemaResponse {
  labels: AssociationLabel[];
  error?: string;
}

export function HubSpotContactLabelEditor({
  workspaceId,
  contactId,
  contactName,
  initialLabels,
}: Props) {
  const [currentLabels, setCurrentLabels] = useState<string[]>(
    initialLabels ?? []
  );
  // Primary association is implicit-true for every contact we surface
  // (the sync filter), but the picker lets a CSM intentionally
  // unset it — that detaches the contact from the company as a
  // primary association in HubSpot. We track the post-save state
  // separately from the picker draft so we can render a "removed"
  // signal in place of the chip without removing the row itself
  // until the sync catches up.
  const [primarySet, setPrimarySet] = useState(true);
  const [editing, setEditing] = useState(false);
  const [schema, setSchema] = useState<AssociationLabel[] | null>(null);
  const [draftLabels, setDraftLabels] = useState<Set<string>>(
    new Set(initialLabels ?? [])
  );
  const [draftPrimary, setDraftPrimary] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemovePrimary, setConfirmRemovePrimary] = useState(false);

  // Lazy-load the schema the first time the editor opens. Once
  // fetched it stays in component state for the lifetime of the
  // panel — schemas rarely change inside a single session.
  useEffect(() => {
    if (!editing || schema !== null) return;
    let cancelled = false;
    fetch("/api/admin/hubspot-labels", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as SchemaResponse;
      })
      .then((j) => {
        if (cancelled) return;
        setSchema(j.labels);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          `Couldn't load label list: ${
            e instanceof Error ? e.message : "unknown"
          }`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [editing, schema]);

  function openEditor() {
    setDraftLabels(new Set(currentLabels));
    setDraftPrimary(primarySet);
    setConfirmRemovePrimary(false);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setConfirmRemovePrimary(false);
    setError(null);
  }

  function toggle(label: string) {
    setDraftLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function attemptSave() {
    // Unticking Primary is a destructive HubSpot change — gate it
    // behind a second click so a CSM doesn't accidentally detach a
    // contact from a company while they were really after a
    // user-label change.
    if (primarySet && !draftPrimary && !confirmRemovePrimary) {
      setConfirmRemovePrimary(true);
      return;
    }
    void save();
  }

  async function save() {
    setBusy(true);
    setError(null);
    const labels = Array.from(draftLabels);
    const primary = draftPrimary;
    try {
      const r = await fetch(
        `/api/customers/${encodeURIComponent(workspaceId)}/contacts/${encodeURIComponent(contactId)}/labels`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labels, primary }),
        }
      );
      const j = (await r.json().catch(() => ({}))) as {
        labels?: string[];
        primary?: boolean;
        error?: string;
        known?: string[];
      };
      if (!r.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setCurrentLabels(j.labels ?? labels);
      setPrimarySet(j.primary ?? primary);
      setEditing(false);
      setConfirmRemovePrimary(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  // USER_DEFINED labels are the ones admins create and the team
  // actually uses. HUBSPOT_DEFINED entries (primary association,
  // default unlabeled) are filtered out — they're not pickable.
  const pickable =
    schema?.filter((l) => l.category === "USER_DEFINED") ?? [];

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {/* Primary-company system chip. Editable via the picker, but
       *  shown statically when not in edit mode so the dashboard
       *  reads the same as HubSpot's own contact panel. After a
       *  removal, render a struck-through "removed" variant until
       *  the next sync drops the contact off this customer. */}
      {primarySet ? (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-surface-2 dark:bg-canvas/40 border-border text-muted"
          title="HubSpot system label: this contact is associated as Primary Company in HubSpot. Click 'Edit labels' to remove."
        >
          Contact with primary company
        </span>
      ) : (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 text-red-800 dark:text-red-200 line-through decoration-red-400"
          title="Primary Company association removed in HubSpot. Contact drops off this customer on the next sync."
        >
          Contact with primary company
        </span>
      )}
      {currentLabels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/40 text-indigo-900 dark:text-indigo-200"
          title={`HubSpot association label: ${label}`}
        >
          {label}
        </span>
      ))}
      {editing ? null : (
        <button
          type="button"
          onClick={openEditor}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium border border-border-strong rounded-full text-fg bg-surface hover:bg-accent hover:text-accent-fg hover:border-accent transition-colors"
          title={`Edit HubSpot association labels for ${contactName}`}
        >
          <span aria-hidden="true">✎</span>
          Edit labels
        </button>
      )}
      {editing ? (
        <div className="basis-full mt-1 p-2 border border-border rounded-md bg-canvas/40 space-y-2">
          {schema === null && !error ? (
            <div className="text-[11px] text-muted">Loading labels…</div>
          ) : null}
          {/* Primary Company sits above the USER_DEFINED labels with
           *  a divider — it's structurally different (system label,
           *  destructive to remove) so visually separating it makes
           *  the intent of the checkbox unambiguous. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <label
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border cursor-pointer transition ${
                draftPrimary
                  ? "bg-surface-2 border-border text-fg"
                  : "bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/40 text-red-900 dark:text-red-200"
              }`}
              title="HubSpot system label. Unticking removes the contact's primary association with this company."
            >
              <input
                type="checkbox"
                checked={draftPrimary}
                onChange={() => {
                  setDraftPrimary((v) => !v);
                  setConfirmRemovePrimary(false);
                }}
                className="h-3 w-3 cursor-pointer"
              />
              Contact with primary company
            </label>
          </div>
          {pickable.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/60">
              {pickable.map((l) => {
                const checked = draftLabels.has(l.label);
                return (
                  <label
                    key={l.typeId}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border cursor-pointer transition ${
                      checked
                        ? "bg-accent text-accent-fg border-accent"
                        : "bg-surface border-border-strong text-fg hover:bg-canvas"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(l.label)}
                      className="h-3 w-3 cursor-pointer"
                    />
                    {l.label}
                  </label>
                );
              })}
            </div>
          ) : null}
          {confirmRemovePrimary ? (
            <div className="text-[11px] text-red-800 dark:text-red-200 bg-red-50 dark:bg-red-500/10 border border-red-300 dark:border-red-500/40 rounded p-1.5">
              Removing the primary association will detach {contactName} from
              this company in HubSpot. They'll drop off this customer on the
              next sync. Click <strong>Confirm remove</strong> to proceed.
            </div>
          ) : null}
          {error ? (
            <div className="text-[11px] text-red-700 dark:text-red-300">
              {error}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={attemptSave}
              disabled={busy}
              className={`px-2 py-0.5 text-[11px] rounded-md disabled:opacity-50 ${
                confirmRemovePrimary
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "bg-accent text-accent-fg hover:bg-accent-hover"
              }`}
            >
              {busy
                ? "Saving…"
                : confirmRemovePrimary
                ? "Confirm remove"
                : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] border border-border-strong rounded-md hover:bg-surface disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
