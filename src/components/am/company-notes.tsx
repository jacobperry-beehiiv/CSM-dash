"use client";

import { useCallback, useEffect, useState } from "react";
import type { CustomerSignal } from "@/lib/data/customer-signals";
import { CollapsibleSection } from "../collapsible-section";

/**
 * Inline "Notes" editor used inside the AM tabs' expanded company
 * rows. Reads + writes the same `customer-signals` KV the CSM
 * profile-page renders from, surfacing two kinds:
 *
 *   • `note` — free-text scratchpad notes a CSM writes by hand.
 *     Editable, deletable, can be mirrored to HubSpot.
 *   • `action_log` — auto-events emitted by every mutation endpoint
 *     when a bulk or per-row action runs against the workspace
 *     ("Past-due email sent", "Marked Skip", "Pinged on Slack"…).
 *     Visually distinct (muted, 🤖 prefix) and read-only — no Edit /
 *     Delete / Post-to-HubSpot affordances.
 *
 * Both render in a single chronological feed so the CSM sees actions
 * interleaved with their own commentary. The count chip in the
 * section header is intentionally CSM-notes-only — auto-events would
 * otherwise inflate it and break its "has the CSM written anything?"
 * signal.
 *
 * Wire-up:
 *   • GET  /api/customer-signals?workspace_id=…  → list, filter to
 *     `note` + `action_log`
 *   • POST /api/customer-signals { workspace_id, kind: "note", text }
 *     creates a manual note; the API stamps `created_at` + `event_at`.
 *   • Action-log entries are written server-side by the endpoint that
 *     fired the action — see appendActionLog() in customer-signals.ts.
 */
interface Props {
  workspaceId: string;
}

export function CompanyNotes({ workspaceId }: Props) {
  const [notes, setNotes] = useState<CustomerSignal[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-note "Post to HubSpot" state — keyed by signal id. The button
  // is per-row so multiple posts can be in-flight without blocking
  // each other.
  const [hubspotBusy, setHubspotBusy] = useState<Record<string, boolean>>(
    {}
  );
  const [hubspotError, setHubspotError] = useState<Record<string, string>>(
    {}
  );

  const reload = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/customer-signals?workspace_id=${encodeURIComponent(workspaceId)}`,
        { cache: "no-store" }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { signals: CustomerSignal[] };
      // Surface free-text notes + auto-emitted action-log entries.
      // Other kinds (touchpoint, goal, risk_signal, …) still live in
      // the CSM /account profile view, not here.
      const feed = (j.signals ?? []).filter(
        (s) => s.kind === "note" || s.kind === "action_log"
      );
      // Server already trims + sorts newest-first by event_at, but the
      // GET result is whatever order it landed in storage, so resort
      // here defensively.
      feed.sort((a, b) => {
        const ad = Date.parse(a.event_at ?? a.created_at) || 0;
        const bd = Date.parse(b.event_at ?? b.created_at) || 0;
        return bd - ad;
      });
      setNotes(feed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load notes");
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function saveNote() {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/customer-signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          kind: "note",
          text,
          // event_at defaults to created_at server-side; passing it
          // explicitly makes the "happened just now" intent obvious in
          // the stored row.
          event_at: new Date().toISOString(),
          source: "dashboard",
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setDraft("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save note");
    } finally {
      setSaving(false);
    }
  }

  async function postToHubspot(signalId: string) {
    setHubspotBusy((prev) => ({ ...prev, [signalId]: true }));
    setHubspotError((prev) => {
      const next = { ...prev };
      delete next[signalId];
      return next;
    });
    try {
      const r = await fetch(
        "/api/customer-signals/post-to-hubspot",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: workspaceId,
            signal_id: signalId,
          }),
        }
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      // Reload to pick up the new metadata.hubspot_note_id stamp so
      // the row's button flips to "✓ Posted to HubSpot".
      await reload();
    } catch (e) {
      setHubspotError((prev) => ({
        ...prev,
        [signalId]: e instanceof Error ? e.message : "Failed to post",
      }));
    } finally {
      setHubspotBusy((prev) => {
        const next = { ...prev };
        delete next[signalId];
        return next;
      });
    }
  }

  async function deleteNote(id: string) {
    if (!confirm("Delete this note?")) return;
    try {
      const r = await fetch(
        `/api/customer-signals?workspace_id=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete note");
    }
  }

  // Count chip surfaces CSM-authored notes only — auto-events would
  // otherwise inflate the count and lose its "human has written
  // here" signal.
  const count = (notes ?? []).filter((n) => n.kind === "note").length;

  return (
    <CollapsibleSection
      title="Notes"
      trailing={
        count > 0 ? (
          <span className="text-xs text-muted font-normal normal-case">
            {count}
          </span>
        ) : null
      }
    >
      <div className="space-y-3">
        {notes === null ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="text-xs text-muted italic">
            No notes yet. Add the first one below.
          </p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => {
              const isAuto = n.kind === "action_log";
              if (isAuto) {
                return (
                  <li
                    key={n.id}
                    className="rounded-md border border-border/60 bg-canvas/20 px-3 py-2 text-xs"
                  >
                    <div className="flex items-baseline gap-2 text-muted">
                      <span aria-hidden>🤖</span>
                      <span className="text-fg/80 italic break-words">
                        {n.text}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-subtle pl-5">
                      {n.created_by ?? "—"} · {fmtWhen(n.event_at ?? n.created_at)}
                    </p>
                  </li>
                );
              }
              const posted = Boolean(
                (n.metadata as Record<string, unknown> | undefined)
                  ?.hubspot_note_id
              );
              const busy = Boolean(hubspotBusy[n.id]);
              const hsErr = hubspotError[n.id];
              return (
                <li
                  key={n.id}
                  className="rounded-md border border-border bg-canvas/40 p-3 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-xs text-muted">
                      <span className="font-medium text-fg">
                        {n.created_by ?? "—"}
                      </span>{" "}
                      · {fmtWhen(n.event_at ?? n.created_at)}
                    </p>
                    <button
                      type="button"
                      onClick={() => void deleteNote(n.id)}
                      className="text-[11px] text-muted hover:text-red-600 hover:underline"
                      title="Delete this note"
                    >
                      Delete
                    </button>
                  </div>
                  <p className="mt-1 text-fg whitespace-pre-wrap break-words">
                    {n.text}
                  </p>
                  <div className="mt-2 flex items-center justify-end gap-2">
                    {posted ? (
                      <span
                        className="text-[11px] text-emerald-700 dark:text-emerald-300"
                        title="This note has been mirrored to the HubSpot company timeline."
                      >
                        ✓ Posted to HubSpot
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void postToHubspot(n.id)}
                        disabled={busy}
                        className="text-[11px] px-2 py-1 border border-border-strong rounded-md hover:bg-canvas disabled:opacity-50"
                        title="Create this note on the HubSpot company's timeline so it's visible alongside other CRM activity."
                      >
                        {busy ? "Posting…" : "📥 Post to HubSpot"}
                      </button>
                    )}
                  </div>
                  {hsErr ? (
                    <p className="mt-1 text-[11px] text-red-700 dark:text-red-300">
                      {hsErr}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note for this account…"
            rows={3}
            className="w-full px-3 py-2 border border-border-strong rounded-md text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 resize-y"
            disabled={saving}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-subtle">
              Saved to <code className="font-mono">customer-signals</code> as{" "}
              <code className="font-mono">kind:&nbsp;note</code> — also visible
              on the CSM account profile.
            </p>
            <button
              type="button"
              onClick={() => void saveNote()}
              disabled={saving || draft.trim().length === 0}
              className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </div>

        {error ? (
          <div className="text-xs text-red-700 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-2">
            {error}
          </div>
        ) : null}
      </div>
    </CollapsibleSection>
  );
}

/** "May 29, 4:32 PM" — short enough to sit in the chip-style header but
 *  still unambiguous across a few weeks of notes. */
function fmtWhen(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
