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

  function setSlackId(id: string, slackId: string) {
    // Empty string → store as null so future code paths can do a
    // truthy check without worrying about whitespace-only.
    const next = slackId.trim() || null;
    update(
      members.map((m) =>
        m.id === id ? { ...m, slack_user_id: next ?? undefined } : m
      )
    );
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
            <input
              type="text"
              value={m.slack_user_id ?? ""}
              onChange={(e) => setSlackId(m.id, e.target.value)}
              placeholder="Slack ID (U02ABC123)"
              title="Slack user ID for due-date reminders. Find it via the user's Slack profile → … → Copy member ID."
              className="w-44 px-2 py-1 bg-transparent border border-transparent hover:border-border focus:border-accent rounded text-[12px] font-mono focus:outline-none"
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

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={addMember}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
        >
          + Add member
        </button>
        <ReminderSweepButtons />
      </div>
    </div>
  );
}

/** Two-button row: dry-run reports who WOULD be pinged without
 *  actually sending; live run does the work. Both report counts
 *  inline so admins can verify the mapping before they cron it. */
function ReminderSweepButtons() {
  const [running, setRunning] = useState<"dry" | "live" | null>(null);
  const [report, setReport] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setRunning(dryRun ? "dry" : "live");
    setReport(null);
    try {
      const r = await fetch(
        `/api/team-tasks/reminders/sweep${dryRun ? "?dryRun=1" : ""}`,
        { method: "POST" }
      );
      const j = (await r.json()) as {
        ok?: boolean;
        error?: string;
        sent?: number;
        checked?: number;
        skipped_no_slack_id?: number;
        skipped_already_sent?: number;
        failures?: { task: string; member: string; error: string }[];
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const parts = [
        `${dryRun ? "Dry run" : "Sent"}: ${j.sent ?? 0}`,
        `checked: ${j.checked ?? 0}`,
        j.skipped_no_slack_id
          ? `missing slack id: ${j.skipped_no_slack_id}`
          : null,
        j.skipped_already_sent
          ? `already sent: ${j.skipped_already_sent}`
          : null,
        j.failures?.length ? `failures: ${j.failures.length}` : null,
      ].filter(Boolean);
      setReport(parts.join(" · "));
    } catch (e) {
      setReport(`Failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setRunning(null);
    }
  }

  return (
    <>
      <button
        onClick={() => run(true)}
        disabled={running !== null}
        className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
        title="Report who WOULD be pinged without actually sending."
      >
        {running === "dry" ? "Checking…" : "Reminder dry run"}
      </button>
      <button
        onClick={() => run(false)}
        disabled={running !== null}
        className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
        title="Send Slack DMs for any task at a reminder stage now."
      >
        {running === "live" ? "Sending…" : "Send reminders now"}
      </button>
      {report ? (
        <span className="text-xs text-muted">{report}</span>
      ) : null}
    </>
  );
}
