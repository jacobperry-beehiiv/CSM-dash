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
  /** Account owner's email, threaded through from the customer
   *  detail panel. When a contact row's email matches (case-
   *  insensitive), we render an "Account owner" chip inline
   *  instead of duplicating them as a synthetic top row. */
  ownerEmail?: string | null;
}

interface BulkResult {
  ok: number;
  failed: Array<{ contact_id: string; error: string }>;
}

export function HubSpotContactsEditableList({
  contacts,
  workspaceId,
  ownerEmail,
}: Props) {
  const ownerLower = (ownerEmail ?? "").trim().toLowerCase();
  // Tracks contact IDs whose labels we've cleared in this session;
  // overrides the snapshot value on render so the chips disappear
  // immediately without waiting for the parent to refetch. When the
  // bulk action also detached primary, the row is still in the list
  // (snapshot lag) but renders the struck-through Primary chip via
  // the per-row editor's `key` reset.
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [detached, setDetached] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Two-step confirm tracked per-action so toggling between them
  // doesn't fire the wrong destructive op.
  const [confirming, setConfirming] = useState<
    null | "clear" | "detach"
  >(null);
  const [message, setMessage] = useState<string | null>(null);

  // Every contact is selectable — even ones with only the system
  // Primary chip, since the CSM might want to bulk-detach them from
  // the company. Already-cleared rows drop out of the selection so
  // the master checkbox stays meaningful.
  const selectable = useMemo(
    () => contacts.filter((c) => !detached.has(c.id)),
    [contacts, detached]
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
    setConfirming(null);
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((c) => c.id)));
    }
    setMessage(null);
    setConfirming(null);
  }

  function attemptAction(kind: "clear" | "detach") {
    if (selected.size === 0) return;
    if (confirming !== kind) {
      setConfirming(kind);
      return;
    }
    void runBulk(kind);
  }

  async function runBulk(kind: "clear" | "detach"): Promise<void> {
    setBusy(true);
    setMessage(null);
    const ids = [...selected];
    const result: BulkResult = { ok: 0, failed: [] };
    const body =
      kind === "detach"
        ? { labels: [], primary: false }
        : { labels: [], primary: true };
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
              body: JSON.stringify(body),
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
    if (kind === "detach") {
      setDetached((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (!result.failed.find((f) => f.contact_id === id)) {
            next.add(id);
          }
        }
        return next;
      });
    }
    setSelected(new Set());
    setConfirming(null);
    setBusy(false);
    const verb = kind === "detach" ? "Detached" : "Cleared labels on";
    if (result.failed.length === 0) {
      setMessage(
        `${verb} ${result.ok} contact${result.ok === 1 ? "" : "s"}.`
      );
    } else {
      setMessage(
        `${verb} ${result.ok}; ${result.failed.length} failed (${result.failed
          .map((f) => f.error)
          .slice(0, 2)
          .join("; ")}${result.failed.length > 2 ? "…" : ""}).`
      );
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2 text-[11px]">
        <label className="inline-flex items-center gap-1 cursor-pointer text-muted hover:text-fg">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="h-3 w-3 cursor-pointer"
          />
          Select all ({selectable.length})
        </label>
        <span className="text-subtle">·</span>
        <span className="text-muted">{selected.size} selected</span>
        {selected.size > 0 ? (
          <>
            <button
              type="button"
              onClick={() => attemptAction("clear")}
              disabled={busy}
              className={`px-2 py-0.5 rounded-md font-medium border disabled:opacity-50 ${
                confirming === "clear"
                  ? "bg-amber-600 text-white border-amber-600 hover:bg-amber-700"
                  : "bg-surface text-fg border-border-strong hover:bg-canvas"
              }`}
              title="Removes USER_DEFINED labels on every selected contact. Primary association stays intact."
            >
              {busy && confirming === "clear"
                ? "Clearing…"
                : confirming === "clear"
                ? `Confirm clear (${selected.size})`
                : "Clear labels"}
            </button>
            <button
              type="button"
              onClick={() => attemptAction("detach")}
              disabled={busy}
              className={`px-2 py-0.5 rounded-md font-medium border disabled:opacity-50 ${
                confirming === "detach"
                  ? "bg-red-600 text-white border-red-600 hover:bg-red-700"
                  : "bg-surface text-fg border-border-strong hover:bg-canvas"
              }`}
              title="Removes USER_DEFINED labels AND the Primary Company association. Selected contacts drop off this customer on next sync."
            >
              {busy && confirming === "detach"
                ? "Detaching…"
                : confirming === "detach"
                ? `Confirm detach (${selected.size})`
                : "Remove from this company"}
            </button>
            {confirming && !busy ? (
              <button
                type="button"
                onClick={() => {
                  setConfirming(null);
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
      <ul className="divide-y divide-border/60">
        {contacts.map((c) => {
          const liveLabels = cleared.has(c.id) ? [] : c.labels ?? [];
          const wasDetached = detached.has(c.id);
          return (
            <li key={c.id} className="py-2.5 flex items-start gap-3 text-sm">
              {/* Per-row checkbox. Every row is selectable — even
                * primary-only contacts, since the bulk-detach action
                * needs to reach them. Already-detached rows render
                * the box disabled so a CSM doesn't repeat the op. */}
              <input
                type="checkbox"
                disabled={wasDetached || busy}
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className={`mt-1.5 h-3 w-3 cursor-pointer ${
                  wasDetached ? "opacity-25 cursor-not-allowed" : ""
                }`}
                title={
                  wasDetached
                    ? "Already detached — drops off on next sync"
                    : "Select for bulk action"
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
                  {ownerLower &&
                  (c.email ?? "").trim().toLowerCase() === ownerLower ? (
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/40 text-blue-900 dark:text-blue-200"
                      title="q10600 owner_email — the workspace's Stripe billing contact / beehiiv owner."
                    >
                      Account owner
                    </span>
                  ) : null}
                  {c.is_primary ? (
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/40 text-emerald-900 dark:text-emerald-200"
                      title="HubSpot association type = Contact with Primary Company"
                    >
                      Primary
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
                  key={`${c.id}::${liveLabels.join("|")}::${wasDetached ? "d" : "p"}`}
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
