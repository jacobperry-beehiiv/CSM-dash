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
  const [editing, setEditing] = useState(false);
  const [schema, setSchema] = useState<AssociationLabel[] | null>(null);
  const [draftLabels, setDraftLabels] = useState<Set<string>>(
    new Set(initialLabels ?? [])
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
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

  async function save() {
    setBusy(true);
    setError(null);
    const labels = Array.from(draftLabels);
    try {
      const r = await fetch(
        `/api/customers/${encodeURIComponent(workspaceId)}/contacts/${encodeURIComponent(contactId)}/labels`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labels }),
        }
      );
      const j = (await r.json().catch(() => ({}))) as {
        labels?: string[];
        error?: string;
        known?: string[];
      };
      if (!r.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setCurrentLabels(j.labels ?? labels);
      setEditing(false);
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
      {/* Implicit-but-shown system label — every contact we surface
       *  passed the typeId === 2 ("Contact with Primary Company")
       *  filter in the sync, so the chip is true-by-construction.
       *  Surfaced explicitly so the dashboard reads the same as
       *  HubSpot's own contact panel, which shows this chip on
       *  every association. Read-only — HUBSPOT_DEFINED labels
       *  can't be toggled by users. */}
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-surface-2 dark:bg-canvas/40 border-border text-muted"
        title="HubSpot system label: every contact shown here is associated as Primary Company in HubSpot"
      >
        Contact with primary company
      </span>
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
          {currentLabels.length === 0 ? "Add labels" : "Edit labels"}
        </button>
      )}
      {editing ? (
        <div className="basis-full mt-1 p-2 border border-border rounded-md bg-canvas/40 space-y-2">
          {schema === null && !error ? (
            <div className="text-[11px] text-muted">Loading labels…</div>
          ) : null}
          {pickable.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
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
          {error ? (
            <div className="text-[11px] text-red-700 dark:text-red-300">
              {error}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] bg-accent text-accent-fg rounded-md hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
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
