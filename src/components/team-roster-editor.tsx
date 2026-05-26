"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newMemberId, type TeamMember } from "@/lib/team-tasks/types";
import type { SettingsShape } from "@/lib/data/settings";

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
  // CSM → Slack ID map from /settings/slack — single source of truth
  // we link team members against. Fetched on mount so the dropdown
  // reflects whatever IDs an admin has already configured globally.
  const [csmSlackIds, setCsmSlackIds] = useState<Record<string, string>>({});
  const dirtyRef = useRef<TeamMember[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        const s = j as SettingsShape;
        setCsmSlackIds(s.slack?.csm_user_ids ?? {});
      })
      .catch(() => {
        // Failure here is non-fatal — the manual slack_user_id input
        // still works as a fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const csmHandleOptions = useMemo(
    () => Object.keys(csmSlackIds).sort(),
    [csmSlackIds]
  );

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

  function setCsmHandle(id: string, handle: string) {
    const next = handle.trim() || null;
    update(
      members.map((m) =>
        m.id === id ? { ...m, csm_handle: next ?? undefined } : m
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
        {members.map((m, i) => {
          // Effective Slack ID surfaced inline so admins can see at a
          // glance whether reminders will reach this member. Manual
          // override wins; otherwise we dereference csm_handle through
          // the global Slack settings map.
          const resolvedSlackId = m.slack_user_id
            ? m.slack_user_id
            : m.csm_handle
              ? csmSlackIds[m.csm_handle]
              : null;
          return (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-2 px-3 py-2 hover:bg-canvas/40"
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
                className="flex-1 min-w-[10rem] px-2 py-1 bg-transparent border border-transparent hover:border-border focus:border-accent rounded text-sm focus:outline-none"
              />
              <select
                value={m.csm_handle ?? ""}
                onChange={(e) => setCsmHandle(m.id, e.target.value)}
                title="Link to a CSM from /settings/slack — Slack ID is sourced from there automatically."
                className="px-2 py-1 border border-border-strong rounded-md text-xs bg-surface min-w-[10rem]"
              >
                <option value="">— link to CSM —</option>
                {csmHandleOptions.map((h) => (
                  <option key={h} value={h}>
                    {h.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={m.slack_user_id ?? ""}
                onChange={(e) => setSlackId(m.id, e.target.value)}
                placeholder="Slack ID override"
                title="Manual Slack user ID. Use this when the team member isn't a CSM (admin, contractor)."
                className="w-40 px-2 py-1 bg-transparent border border-transparent hover:border-border focus:border-accent rounded text-[12px] font-mono focus:outline-none"
              />
              {/* Effective-ID readout. Green when reminders will reach this
                  member; muted when there's nothing to dereference yet. */}
              {resolvedSlackId ? (
                <code
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                  title={`Effective Slack ID — ${
                    m.slack_user_id ? "override" : "via " + m.csm_handle
                  }`}
                >
                  → {resolvedSlackId}
                </code>
              ) : (
                <span
                  className="text-[11px] text-subtle italic"
                  title="No Slack ID — reminders will skip this member."
                >
                  no Slack ID
                </span>
              )}
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
          );
        })}
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
        skipped_no_due?: number;
        skipped_no_slack_id?: number;
        skipped_already_sent?: number;
        failures?: { task: string; member: string; error: string }[];
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      // Build a layered report so every "why nothing happened" case is
      // surfaced: a stage-match miss looks different from "all members
      // are unmapped" looks different from "Slack rejected the DM."
      const lines: string[] = [];
      lines.push(
        `${dryRun ? "Dry run" : "Sent"}: ${j.sent ?? 0} · checked unchecked assignments: ${j.checked ?? 0}`
      );
      if (j.skipped_no_due) {
        lines.push(`Tasks skipped (no due date): ${j.skipped_no_due}`);
      }
      if (j.skipped_no_slack_id) {
        lines.push(
          `Members skipped (no Slack ID resolvable): ${j.skipped_no_slack_id}`
        );
      }
      if (j.skipped_already_sent) {
        lines.push(
          `Already pinged this stage: ${j.skipped_already_sent}`
        );
      }
      if (j.failures?.length) {
        // Surface the actual Slack errors inline — they're usually
        // obvious (e.g. "channel_not_found" = bad ID, "cannot_dm_bot"
        // = pointed at the bot itself).
        for (const f of j.failures.slice(0, 5)) {
          lines.push(`✗ ${f.member} → ${f.task}: ${f.error}`);
        }
        if (j.failures.length > 5) {
          lines.push(`…and ${j.failures.length - 5} more failures`);
        }
      }
      if (
        (j.sent ?? 0) === 0 &&
        (j.checked ?? 0) === 0 &&
        !j.failures?.length
      ) {
        lines.push(
          "Nothing matched a reminder stage right now — try a task with a due date 3, 1, or 0 days out."
        );
      }
      setReport(lines.join("\n"));
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
        <pre className="text-xs text-muted whitespace-pre-wrap break-words w-full mt-1 font-sans">
          {report}
        </pre>
      ) : null}
    </>
  );
}
