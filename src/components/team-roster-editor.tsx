"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { newMemberId, type TeamMember } from "@/lib/team-tasks/types";

/**
 * Admin UI for the shared team roster powering the open-asks tracker
 * on the mission-control root page. Add, rename, reorder, remove.
 *
 * Autosaves to /api/team-tasks/members 800ms after the last change —
 * same cadence as the open-asks table itself. The dedicated members
 * endpoint reads-modifies-writes server-side so admin edits here never
 * stomp tasks a CSM is autosaving from the dashboard.
 */
export function TeamRosterEditor({ initial }: { initial: TeamMember[] }) {
  const [members, setMembers] = useState<TeamMember[]>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef<TeamMember[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(async (next: TeamMember[]) => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/team-tasks/members", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: next }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, []);

  function update(next: TeamMember[]) {
    setMembers(next);
    dirtyRef.current = next;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (dirtyRef.current) save(dirtyRef.current);
    }, 800);
  }

  // Flush pending save on unmount so navigating away mid-keystroke
  // doesn't drop the last edit.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (dirtyRef.current) {
        void fetch("/api/team-tasks/members", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ members: dirtyRef.current }),
          keepalive: true,
        });
      }
    };
  }, []);

  function rename(id: string, label: string) {
    update(members.map((m) => (m.id === id ? { ...m, label } : m)));
  }

  function remove(id: string) {
    if (members.length <= 1) {
      setError("Roster must include at least one member.");
      return;
    }
    update(members.filter((m) => m.id !== id));
  }

  function move(id: string, delta: 1 | -1) {
    const idx = members.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const target = idx + delta;
    if (target < 0 || target >= members.length) return;
    const next = [...members];
    [next[idx], next[target]] = [next[target], next[idx]];
    update(next);
  }

  function addMember() {
    const label = "New member";
    const id = newMemberId(label, members.map((m) => m.id));
    update([...members, { id, label }]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          People here become columns on the open-asks tracker. Removing
          someone keeps their existing checkbox history — re-adding the same
          person brings it back.
        </p>
        <span className="text-xs text-muted min-w-[80px] text-right">
          {saving ? (
            <span>Saving…</span>
          ) : error ? (
            <span className="text-red-600">{error}</span>
          ) : savedAt ? (
            <span className="text-subtle">
              Saved{" "}
              {new Date(savedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </span>
      </div>

      <ul className="divide-y divide-border bg-surface border border-border rounded-md">
        {members.map((m, i) => (
          <li
            key={m.id}
            className="flex items-center gap-2 px-3 py-2 hover:bg-canvas/40"
          >
            <div className="flex flex-col gap-0">
              <button
                onClick={() => move(m.id, -1)}
                disabled={i === 0}
                aria-label="Move up"
                className="text-subtle hover:text-fg disabled:opacity-30 leading-none"
              >
                ▲
              </button>
              <button
                onClick={() => move(m.id, 1)}
                disabled={i === members.length - 1}
                aria-label="Move down"
                className="text-subtle hover:text-fg disabled:opacity-30 leading-none"
              >
                ▼
              </button>
            </div>
            <input
              type="text"
              value={m.label}
              onChange={(e) => rename(m.id, e.target.value)}
              placeholder="Display name"
              className="flex-1 px-2 py-1 bg-transparent border border-transparent hover:border-border focus:border-accent rounded text-sm focus:outline-none"
            />
            <code className="text-[11px] text-subtle font-mono">{m.id}</code>
            <button
              onClick={() => remove(m.id)}
              className="text-subtle hover:text-red-600 text-sm px-2"
              title="Remove from roster"
              aria-label={`Remove ${m.label}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <button
        onClick={addMember}
        className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
      >
        + Add member
      </button>
    </div>
  );
}
