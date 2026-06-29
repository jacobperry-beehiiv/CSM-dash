"use client";

import { useMemo, useState } from "react";
import type { HubSpotContactRef } from "@/lib/types";
import { fmtDate } from "./format";
import { HubSpotContactLabelEditor } from "./hubspot-contact-label-editor";

/**
 * Client-side variant of the HubSpot contacts list rendered inside
 * a customer detail panel. Owns bulk-select state so a CSM can clear
 * USER_DEFINED labels across many contacts in one pass instead of
 * opening the picker N times.
 *
 * Single-row editing still happens through `HubSpotContactLabelEditor`
 * — this component just sits above it. We optimistically blank the
 * row's chips on a successful bulk-clear; the editor's own state is
 * reset by remounting it (the `key` includes the labels signature).
 */
interface Props {
  contacts: HubSpotContactRef[];
  workspaceId: string;
}

interface BulkResult {
  ok: number;
  failed: Array<{ contact_id: string; error: string }>;
}

export function HubSpotContactsEditableList({ contacts, workspaceId }: Props) {
  // Tracks contact IDs whose labels we've cleared in this session;
  // overrides the snapshot value on render so the chips disappear
  // immediately without waiting for the parent to refetch.
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Contacts that actually have USER_DEFINED labels right now —
  // selecting one without labels would just be a no-op API call.
  const selectable = useMemo(
    () =>
      contacts.filter(
        (c) => !cleared.has(c.id) && (c.labels ?? []).length > 0
      ),
    [contacts, cleared]
  );

  const allSelected =
    selectable.length > 0 && selected.size === selectable.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMessage(null);
    setConfirming(false);
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((c) => c.id)));
    }
    setMessage(null);
    setConfirming(false);
  }

  function attemptClear() {
    if (selected.size === 0) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    void clearLabels();
  }

  async function clearLabels(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const ids = [...selected];
    const result: BulkResult = { ok: 0, failed: [] };
    // Fan out concurrently — typical contact lists are 5-20 so we
    // don't bother with a concurrency cap. The endpoint already
    // refreshes the overlay per-call (PR #83), which is wasteful
    // when N > 1 but cheap enough; a bulk endpoint is a follow-on
    // if it ever becomes a hot path.
    await Promise.all(
      ids.map(async (contactId) => {
        try {
          const r = await fetch(
            `/api/customers/${encodeURIComponent(
              workspaceId
            )}/contacts/${encodeURIComponent(contactId)}/labels`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ labels: [], primary: true }),
            }
          );
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string };
            result.failed.push({
              contact_id: contactId,
              error: j.error ?? `HTTP ${r.status}`,
            });
            return;
          }
          result.ok++;
        } catch (e) {
          result.failed.push({
            contact_id: contactId,
            error: e instanceof Error ? e.message : "Network error",
          });
        }
      })
    );
    setCleared((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (!result.failed.find((f) => f.contact_id === id)) {
          next.add(id);
        }
      }
      return next;
    });
    setSelected(new Set());
    setConfirming(false);
    setBusy(false);
    if (result.failed.length === 0) {
      setMessage(
        `Cleared labels on ${result.ok} contact${result.ok === 1 ? "" : "s"}.`
      );
    } else {
      setMessage(
        `Cleared ${result.ok}; ${result.failed.length} failed (${result.failed
          .map((f) => f.error)
          .slice(0, 2)
          .join("; ")}${result.failed.length > 2 ? "…" : ""}).`
      );
    }
  }

  return (
    <div>
      {selectable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 mb-2 text-[11px]">
          <label className="inline-flex items-center gap-1 cursor-pointer text-muted hover:text-fg">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-3 w-3 cursor-pointer"
            />
            Select all with labels ({selectable.length})
          </label>
          <span className="text-subtle">·</span>
          <span className="text-muted">
            {selected.size} selected
          </span>
          {selected.size > 0 ? (
            <>
              <button
                type="button"
                onClick={attemptClear}
                disabled={busy}
                className={`px-2 py-0.5 rounded-md font-medium border disabled:opacity-50 ${
                  confirming
                    ? "bg-red-600 text-white border-red-600 hover:bg-red-700"
                    : "bg-surface text-fg border-border-strong hover:bg-canvas"
                }`}
              >
                {busy
                  ? "Clearing…"
                  : confirming
                  ? `Confirm clear (${selected.size})`
                  : "Clear labels on selected"}
              </button>
              {confirming && !busy ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setMessage(null);
                  }}
                  className="text-muted hover:text-fg"
                >
                  Cancel
                </button>
              ) : null}
            </>
          ) : null}
          {message ? (
            <span className="text-muted basis-full">{message}</span>
          ) : null}
        </div>
      ) : null}
      <ul className="divide-y divide-border/60">
        {contacts.map((c) => {
          const liveLabels = cleared.has(c.id) ? [] : c.labels ?? [];
          const hasLabels = liveLabels.length > 0;
          return (
            <li key={c.id} className="py-2.5 flex items-start gap-3 text-sm">
              {/* Per-row checkbox. Disabled (and hidden via opacity)
                * when the contact has nothing to clear — saves a CSM
                * from selecting rows the bulk action wouldn't touch. */}
              <input
                type="checkbox"
                disabled={!hasLabels || busy}
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className={`mt-1.5 h-3 w-3 cursor-pointer ${
                  hasLabels ? "" : "opacity-25 cursor-not-allowed"
                }`}
                title={
                  hasLabels
                    ? "Select for bulk label-clear"
                    : "No labels to clear"
                }
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium text-fg break-words">
                    {c.name ?? c.email ?? "(no name)"}
                  </span>
                  {c.job_title ? (
                    <span className="text-[11px] text-subtle">
                      {c.job_title}
                    </span>
                  ) : null}
                </div>
                {c.email ? (
                  <a
                    href={`mailto:${c.email}`}
                    className="text-xs text-muted hover:text-fg break-all"
                  >
                    {c.email}
                  </a>
                ) : null}
                <HubSpotContactLabelEditor
                  key={`${c.id}::${liveLabels.join("|")}`}
                  workspaceId={workspaceId}
                  contactId={c.id}
                  contactName={c.name ?? c.email ?? `contact ${c.id}`}
                  initialLabels={liveLabels}
                />
              </div>
              {c.last_activity_at ? (
                <div
                  className="text-[11px] text-muted whitespace-nowrap"
                  title="HubSpot contact-level notes_last_activity_date"
                >
                  Last activity {fmtDate(c.last_activity_at)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
