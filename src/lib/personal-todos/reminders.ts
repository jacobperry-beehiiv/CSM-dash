import { kvGet, kvSet } from "../storage/kv";
import { loadSettings } from "../data/settings";
import { loadCustomers } from "../data/load-customers";
import { loadAll, saveStateForSweep } from "./store";
import {
  todayYmdUtc,
  type PersonalTodo,
  type PersonalTodosState,
} from "./types";
import { userKeyFromEmail } from "./identity";
import type { Customer } from "../types";

/**
 * Personal-todos sweep — daily cron. Two responsibilities:
 *
 *   1. **Activate scheduled todos.** Any row with `surface_at <= today`
 *      gets its surface_at cleared (so the active list picks it up)
 *      AND the owner gets a one-shot Slack DM. Dedupe key
 *      `${userKey}:${todoId}:surface` so a re-run doesn't double-ping.
 *
 *   2. **Fire due-date reminders.** Same 4-stage ladder as team-tasks:
 *      3 days out / 1 day out / due today / 3 days overdue. Per-stage
 *      dedupe via `${userKey}:${todoId}:${stage}` so each (user, todo,
 *      stage) tuple fires exactly once unless the todo gets re-opened.
 *
 * The identity → Slack mapping comes from the SAME settings the
 * existing dash uses: `settings.slack.csm_user_ids: Record<handle,
 * slack_id>`. To resolve an owner's userKey → Slack ID we go
 * email → handle (via the customer book) → slack_id. When mapping
 * fails (no customer-book entry for the email, no slack_id for the
 * handle), we record a skip + reason and continue — the sweep should
 * never fail just because one CSM hasn't been mapped yet.
 *
 * No new env vars or new settings fields required.
 */

const STATE_KEY = "csm:personal-todo-reminders:v1";
const MS_PER_DAY = 1000 * 60 * 60 * 24;

type Stage =
  | "three_days_out"
  | "one_day_out"
  | "due_today"
  | "three_days_overdue";

const STAGE_DEFS: { stage: Stage; daysUntil: number; label: string }[] = [
  { stage: "three_days_out", daysUntil: 3, label: "due in 3 days" },
  { stage: "one_day_out", daysUntil: 1, label: "due tomorrow" },
  { stage: "due_today", daysUntil: 0, label: "due today" },
  { stage: "three_days_overdue", daysUntil: -3, label: "3 days overdue" },
];

interface ReminderState {
  /** `${userKey}:${todoId}:${stage|surface}` → ISO timestamp. */
  sent: Record<string, string>;
}

async function loadReminderState(): Promise<ReminderState> {
  const stored = await kvGet<Partial<ReminderState>>(STATE_KEY);
  return { sent: stored?.sent ?? {} };
}

async function saveReminderState(s: ReminderState): Promise<void> {
  await kvSet(STATE_KEY, s);
}

export async function resetReminderState(): Promise<{ cleared: number }> {
  const current = await loadReminderState();
  const cleared = Object.keys(current.sent).length;
  await saveReminderState({ sent: {} });
  return { cleared };
}

function daysUntilDue(dueDateYmd: string): number | null {
  const due = new Date(`${dueDateYmd}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return Math.round((due.getTime() - today) / MS_PER_DAY);
}

function stageFor(daysUntil: number): Stage | null {
  if (daysUntil <= -3) return "three_days_overdue";
  if (daysUntil === 0) return "due_today";
  if (daysUntil === 1) return "one_day_out";
  if (daysUntil <= 3 && daysUntil > 1) return "three_days_out";
  return null;
}

/** Resolve a userKey (email) → Slack user ID via the customer book +
 *  csm_user_ids map. Returns null when either lookup fails. Mirrors
 *  the lookup chain in identity.ts in the opposite direction. */
function resolveSlackIdForUserKey(
  userKey: string,
  csmUserIds: Record<string, string>,
  customers: Customer[]
): string | null {
  // email → handle via customer book
  for (const c of customers) {
    if (
      c.customer_success_manager_email &&
      userKeyFromEmail(c.customer_success_manager_email) === userKey
    ) {
      const handle = c.customer_success_manager;
      if (handle && csmUserIds[handle]) return csmUserIds[handle];
      return null;
    }
  }
  return null;
}

export interface SweepResult {
  /** Total open todos walked across all users (excluding scheduled
   *  ones that aren't due to surface yet). */
  checked: number;
  /** Reminders that fired (or would have, in dryRun). */
  sent: number;
  /** Scheduled todos that were activated (surface_at flipped) this run. */
  activated: number;
  /** Owners with no resolvable Slack ID — display the userKey so an
   *  admin can map them at /settings/slack. */
  skipped_no_slack_id_users: string[];
  skipped_no_due: number;
  skipped_already_sent: number;
  failures: { user: string; todo: string; stage: string; error: string }[];
}

export async function runPersonalTodoSweep(
  opts: { dryRun?: boolean } = {}
): Promise<SweepResult> {
  const all = await loadAll();
  const settings = await loadSettings();
  const csmUserIds = settings.slack.csm_user_ids;
  const customers = await loadCustomers();
  const state = await loadReminderState();
  const result: SweepResult = {
    checked: 0,
    sent: 0,
    activated: 0,
    skipped_no_slack_id_users: [],
    skipped_no_due: 0,
    skipped_already_sent: 0,
    failures: [],
  };
  const skippedUsersSeen = new Set<string>();
  const todayYmd = todayYmdUtc();

  // Build a mutable working copy of the state so we can flip surface_at
  // on activated todos in one write at the end.
  const nextState: PersonalTodosState = {
    by_user: Object.fromEntries(
      Object.entries(all.by_user).map(([k, v]) => [k, { todos: [...v.todos] }])
    ),
  };

  for (const [userKey, slice] of Object.entries(nextState.by_user)) {
    const slackId = resolveSlackIdForUserKey(userKey, csmUserIds, customers);

    // ── Pass 1: activate scheduled todos due to surface ──────────────
    for (let i = 0; i < slice.todos.length; i++) {
      const t = slice.todos[i];
      if (!t.surface_at) continue;
      if (t.surface_at > todayYmd) continue; // still future
      if (t.completed_at) continue; // already done
      const dedupeKey = `${userKey}:${t.id}:surface`;
      if (state.sent[dedupeKey]) continue;

      result.activated++;
      if (!slackId) {
        if (!skippedUsersSeen.has(userKey)) {
          skippedUsersSeen.add(userKey);
          result.skipped_no_slack_id_users.push(userKey);
        }
        // Still flip the surface_at so the row appears in the user's
        // active list — they'll see it next time they open the dash
        // even if Slack DM didn't fire.
        if (!opts.dryRun) {
          slice.todos[i] = { ...t, surface_at: null };
        }
        state.sent[dedupeKey] = new Date().toISOString();
        continue;
      }
      try {
        if (!opts.dryRun) {
          await dmActivation({ slackUserId: slackId, todo: t });
          slice.todos[i] = { ...t, surface_at: null };
        }
        state.sent[dedupeKey] = new Date().toISOString();
        result.sent++;
      } catch (e) {
        result.failures.push({
          user: userKey,
          todo: t.title || t.id,
          stage: "surface",
          error: e instanceof Error ? e.message : "unknown",
        });
      }
    }

    // ── Pass 2: fire due-date reminders ──────────────────────────────
    for (const t of slice.todos) {
      // Skip rows still scheduled (surface_at > today). After pass 1
      // their surface_at is cleared if they were due to activate, so
      // this only skips truly-future ones.
      if (t.surface_at && t.surface_at > todayYmd) continue;
      if (t.completed_at) continue;
      if (!t.due_date) {
        result.skipped_no_due++;
        continue;
      }
      const dDays = daysUntilDue(t.due_date);
      if (dDays === null) continue;
      const stage = stageFor(dDays);
      if (!stage) continue;

      result.checked++;
      if (!slackId) {
        if (!skippedUsersSeen.has(userKey)) {
          skippedUsersSeen.add(userKey);
          result.skipped_no_slack_id_users.push(userKey);
        }
        continue;
      }
      const dedupeKey = `${userKey}:${t.id}:${stage}`;
      if (state.sent[dedupeKey]) {
        result.skipped_already_sent++;
        continue;
      }
      try {
        if (!opts.dryRun) {
          await dmReminder({
            slackUserId: slackId,
            todo: t,
            stage,
            daysUntil: dDays,
          });
        }
        state.sent[dedupeKey] = new Date().toISOString();
        result.sent++;
      } catch (e) {
        result.failures.push({
          user: userKey,
          todo: t.title || t.id,
          stage,
          error: e instanceof Error ? e.message : "unknown",
        });
      }
    }
  }

  result.skipped_no_slack_id_users.sort();

  if (!opts.dryRun) {
    await saveStateForSweep(nextState);
    await saveReminderState(state);
  }
  return result;
}

// ─── Slack message helpers ────────────────────────────────────────────

async function dmActivation(args: {
  slackUserId: string;
  todo: PersonalTodo;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not configured");
  const dashUrl =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app/";
  const lines = [
    `:bell: One of your scheduled to-dos is now active:`,
    "",
    `> ${args.todo.title}`,
    args.todo.due_date ? `*Due:* ${args.todo.due_date}` : null,
    args.todo.details ? `*Details:* ${args.todo.details}` : null,
    "",
    `Open the dashboard → ${dashUrl}`,
  ].filter((l): l is string => l !== null);
  await slackPost(token, args.slackUserId, lines.join("\n"));
}

async function dmReminder(args: {
  slackUserId: string;
  todo: PersonalTodo;
  stage: Stage;
  daysUntil: number;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not configured");
  const def = STAGE_DEFS.find((s) => s.stage === args.stage)!;
  const emoji =
    args.stage === "three_days_overdue"
      ? ":rotating_light:"
      : args.stage === "due_today"
        ? ":alarm_clock:"
        : args.stage === "one_day_out"
          ? ":hourglass_flowing_sand:"
          : ":calendar:";
  const dashUrl =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app/";
  const priorityLine =
    args.todo.priority === "high"
      ? "*Priority:* :red_circle: High"
      : args.todo.priority === "medium"
        ? "*Priority:* :large_yellow_circle: Medium"
        : args.todo.priority === "low"
          ? "*Priority:* Low"
          : null;
  const lines = [
    `${emoji} Your personal to-do is *${def.label}*:`,
    "",
    `> ${args.todo.title || "(untitled)"}`,
    "",
    `*Due:* ${args.todo.due_date} (${
      args.daysUntil >= 0
        ? `${args.daysUntil} day${args.daysUntil === 1 ? "" : "s"} from today`
        : `${Math.abs(args.daysUntil)} day${
            Math.abs(args.daysUntil) === 1 ? "" : "s"
          } overdue`
    })`,
    priorityLine,
    args.todo.details ? `*Details:* ${args.todo.details}` : null,
    args.todo.source_meta?.slack_permalink
      ? `*From Slack:* ${args.todo.source_meta.slack_permalink}`
      : null,
    "",
    `Open the dashboard → ${dashUrl}`,
  ].filter((l): l is string => l !== null);
  await slackPost(token, args.slackUserId, lines.join("\n"));
}

async function slackPost(
  token: string,
  channel: string,
  text: string
): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const j = (await res.json()) as { ok: boolean; error?: string };
  if (!j.ok) throw new Error(j.error ?? "chat.postMessage failed");
}
