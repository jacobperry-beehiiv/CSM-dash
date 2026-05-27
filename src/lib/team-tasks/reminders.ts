import { kvGet, kvSet } from "../storage/kv";
import { loadSettings } from "../data/settings";
import { getTeamTasks } from "./store";
import type { TeamTask, TeamMember } from "./types";

/**
 * Due-date reminder sweep for the open-asks tracker. Run on a daily
 * cron. For every task with a due date, finds members whose checkbox
 * is still `unchecked` (i.e. not `checked` and not `na`) and DMs them
 * in Slack a single time per "stage."
 *
 * Stages mirror the human urgency curve, so a member gets a steady
 * but non-spammy stream of nudges as the deadline approaches:
 *
 *    THREE_DAYS_OUT  — first heads-up
 *    ONE_DAY_OUT     — "tomorrow"
 *    DUE_TODAY       — day-of
 *    THREE_DAYS_OVERDUE — last nag; nothing fires after this
 *
 * Dedupe state lives in a single KV row keyed by
 * `${taskId}:${memberId}:${stage}` → ISO timestamp it was sent. This
 * means deleting a task + recreating it with the same id (impossible
 * — ids are random) wouldn't replay, but a checkbox unchecked-then-
 * rechecked WILL replay future stages, which is what we want: if a
 * CSM accidentally re-opens a task, we should remind them again.
 *
 * Skips:
 *   - Tasks with no `due_date` (no schedule to anchor against).
 *   - Members with no `slack_user_id` (no way to ping them).
 *   - Member assignments that are `checked` or `na` (done / out of scope).
 *   - Tasks/members already notified for the active stage.
 */

const STATE_KEY = "csm:team-task-reminders:v1";
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
  /** `${taskId}:${memberId}:${stage}` → ISO timestamp. */
  sent: Record<string, string>;
}

const EMPTY_STATE: ReminderState = { sent: {} };

async function loadState(): Promise<ReminderState> {
  const stored = await kvGet<Partial<ReminderState>>(STATE_KEY);
  return { sent: stored?.sent ?? {} };
}

async function saveState(s: ReminderState): Promise<void> {
  await kvSet(STATE_KEY, s);
}

/** Wipe the dedupe state so every (task, member, stage) eligible
 *  right now will fire on the next sweep. Used by the admin "reset"
 *  button when test-runs left rows that need to be re-pinged for
 *  real, or during development. */
export async function resetReminderState(): Promise<{ cleared: number }> {
  const current = await loadState();
  const cleared = Object.keys(current.sent).length;
  await saveState({ sent: {} });
  return { cleared };
}

/** Drop ms-precision and compute UTC midnight so the day-arithmetic
 *  doesn't drift across timezones. `due_date` is stored as YYYY-MM-DD
 *  (HTML date input) — interpret as UTC. */
function daysUntilDue(dueDateYmd: string): number | null {
  // `YYYY-MM-DD` parsed by Date is UTC midnight already.
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

/** Pick the "active" stage for a task as-of right now. We fire each
 *  stage on the first sweep that catches it — so if a sweep is missed
 *  one day, the next sweep will still pick up the right stage as long
 *  as the threshold hasn't been crossed yet. */
function stageFor(daysUntil: number): Stage | null {
  if (daysUntil <= -3) return "three_days_overdue";
  if (daysUntil === 0) return "due_today";
  if (daysUntil === 1) return "one_day_out";
  if (daysUntil <= 3 && daysUntil > 1) return "three_days_out";
  return null;
}

interface SweepResult {
  checked: number;
  sent: number;
  skipped_no_due: number;
  skipped_no_slack_id: number;
  skipped_already_sent: number;
  /** Display labels of members the sweep saw at a stage but couldn't
   *  DM because they have no resolvable Slack ID. Deduped + sorted —
   *  surfaced in the admin diagnostic so the fix is obvious. */
  skipped_no_slack_id_names: string[];
  failures: { task: string; member: string; error: string }[];
}

/** Resolve a team member to a Slack user ID, preferring the direct
 *  override and falling back to the CSM-handle lookup in the global
 *  Slack settings. Returns null when neither path yields an ID. */
export function resolveMemberSlackId(
  member: TeamMember,
  csmUserIds: Record<string, string>
): string | null {
  if (member.slack_user_id) return member.slack_user_id;
  if (member.csm_handle && csmUserIds[member.csm_handle]) {
    return csmUserIds[member.csm_handle];
  }
  return null;
}

export async function runReminderSweep(
  opts: { dryRun?: boolean } = {}
): Promise<SweepResult> {
  const { tasks, members } = await getTeamTasks();
  const settings = await loadSettings();
  const csmUserIds = settings.slack.csm_user_ids;
  const state = await loadState();
  const result: SweepResult = {
    checked: 0,
    sent: 0,
    skipped_no_due: 0,
    skipped_no_slack_id: 0,
    skipped_already_sent: 0,
    skipped_no_slack_id_names: [],
    failures: [],
  };
  const memberById = new Map(members.map((m) => [m.id, m] as const));
  const skippedNamesSeen = new Set<string>();

  for (const task of tasks) {
    if (!task.due_date) {
      result.skipped_no_due++;
      continue;
    }
    const dDays = daysUntilDue(task.due_date);
    if (dDays === null) continue;
    const stage = stageFor(dDays);
    if (!stage) continue;

    // Anyone whose checkbox is still "unchecked" gets the nudge.
    // Explicit `na` and `checked` mean "I'm done thinking about this
    // task," so they're left alone.
    for (const [memberId, assignment] of Object.entries(task.assignments)) {
      if (assignment !== "unchecked") continue;
      const member = memberById.get(memberId);
      if (!member) continue; // Orphaned assignment for a removed member.
      result.checked++;

      const slackId = resolveMemberSlackId(member, csmUserIds);
      if (!slackId) {
        result.skipped_no_slack_id++;
        if (!skippedNamesSeen.has(member.id)) {
          skippedNamesSeen.add(member.id);
          result.skipped_no_slack_id_names.push(member.label);
        }
        continue;
      }

      const dedupeKey = `${task.id}:${memberId}:${stage}`;
      if (state.sent[dedupeKey]) {
        result.skipped_already_sent++;
        continue;
      }

      try {
        if (!opts.dryRun) {
          await dmReminder({
            slackUserId: slackId,
            member,
            task,
            stage,
            daysUntil: dDays,
          });
        }
        state.sent[dedupeKey] = new Date().toISOString();
        result.sent++;
      } catch (e) {
        result.failures.push({
          task: task.ask || task.id,
          member: member.label,
          error: e instanceof Error ? e.message : "unknown",
        });
      }
    }
  }

  // Sort skipped names alphabetically for stable, readable output.
  result.skipped_no_slack_id_names.sort();

  if (!opts.dryRun) {
    await saveState(state);
  }
  return result;
}

async function dmReminder(args: {
  slackUserId: string;
  member: TeamMember;
  task: TeamTask;
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
    args.task.priority === "high"
      ? "*Priority:* :red_circle: High"
      : args.task.priority === "medium"
        ? "*Priority:* :large_yellow_circle: Medium"
        : args.task.priority === "low"
          ? "*Priority:* Low"
          : null;

  const lines = [
    `${emoji} Hey ${args.member.label}, you have an open ask that's *${def.label}*:`,
    "",
    `> ${args.task.ask || "(untitled task)"}`,
    "",
    `*Due:* ${args.task.due_date} (${
      args.daysUntil >= 0
        ? `${args.daysUntil} day${args.daysUntil === 1 ? "" : "s"} from today`
        : `${Math.abs(args.daysUntil)} day${
            Math.abs(args.daysUntil) === 1 ? "" : "s"
          } overdue`
    })`,
    priorityLine,
    args.task.details ? `*Details:* ${args.task.details}` : null,
    "",
    `Open the tracker → ${dashUrl}`,
  ].filter((l): l is string => l !== null);

  // chat.postMessage with a user ID (U…) opens / reuses a DM
  // conversation automatically as long as the bot has chat:write.
  // No need for a separate conversations.open call.
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.slackUserId,
      text: lines.join("\n"),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const j = (await res.json()) as { ok: boolean; error?: string };
  if (!j.ok) {
    throw new Error(j.error ?? "chat.postMessage failed");
  }
}
