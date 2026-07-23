import type { Customer } from "../types";
import { loadCustomers } from "../data/load-customers";
import { intervalBucket } from "../customer-helpers";
import { loadSettings } from "../data/settings";
import type { SettingsShape } from "../data/settings-types";
import { loadOverrides } from "../data/customer-overrides";
import { appendActionLog } from "../data/customer-signals";
import { applyTodoOps } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import {
  daysUntilRenewal,
  nextRenewalDate,
} from "../renewals/date";
import {
  buildRenewalKickoffMessage,
  buildRenewalMilestoneReply,
} from "../renewals/messages";
import {
  getRenewalThread,
  saveRenewalThreadIfAbsent,
  type RenewalThreadRecord,
} from "../data/renewal-threads";
import {
  hasMilestoneFired,
  markMilestoneFired,
} from "../data/renewal-milestones-fired";
import { fmtCurrency } from "../../components/format";

/**
 * CSM-owned renewals milestone engine.
 *
 * Walks the customer book once, computes days-until-renewal per row
 * via the shared `nextRenewalDate` + `daysUntilRenewal` helpers, and
 * fires exactly-once side effects at each of the 90 / 60 / 30 / 7 day
 * marks. The (workspace_id, milestone_days, renewal_iso) dedupe set
 * in `csm:renewal-milestones-fired:v1` guarantees a re-run on the
 * same day (or a manual retrigger) doesn't double-fire.
 *
 * Milestones:
 *   • 90d — ensure a pricing thread exists in the configured
 *     `renewals_slack_channel_id`. If none, auto-open one and stash
 *     the ts. Also create a personal-todo for the CSM titled
 *     "Kick off renewal for [Company]".
 *   • 60/30/7d — thread-reply into the saved pricing thread with a
 *     pacing update (current lifecycle stage, days until, deep link
 *     back to the customer detail panel, @-mention for the CSM's
 *     Slack ID). Also create a per-CSM personal-todo so the panel
 *     surface picks it up.
 *
 * Excluded from all milestones:
 *   • Monthly cadences — the Renewals workflow is fundamentally
 *     annual-motion.
 *   • Rows whose lifecycle stage is "Renewal Confirmed" or "Renewal
 *     Lost" — the customer has already renewed or churned; further
 *     nudges would be noise.
 *   • Rows with no workspace_id (no way to key the dedupe set).
 *   • Rows with no CSM handle or no CSM email (nobody to notify).
 */

const MILESTONES = [90, 60, 30, 7] as const;
type Milestone = (typeof MILESTONES)[number];

const TERMINAL_STAGES = new Set(["Renewal Confirmed", "Renewal Lost"]);

interface FireResult {
  workspace_id: string;
  workspace_name: string | null;
  csm: string | null;
  milestone_days: Milestone;
  renewal_iso: string;
  slack_ts: string | null;
  todo_created: boolean;
  thread_opened: boolean;
}

interface SkipResult {
  workspace_id: string | null;
  milestone_days: Milestone | null;
  reason: string;
}

interface SweepResult {
  scanned: number;
  fired: FireResult[];
  skipped: SkipResult[];
  failures: { workspace_id: string; milestone_days: Milestone; error: string }[];
  disabled?: boolean;
  reason?: string;
}

interface SweepOpts {
  dryRun?: boolean;
  /** Optional whitelist for the manual "Sweep now" path. */
  workspaceIds?: string[];
  /** Fixed "now" for tests; defaults to real time. */
  now?: Date;
}

async function postToSlack(args: {
  channelId: string;
  text: string;
  threadTs?: string;
}): Promise<{ ts: string | null }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not configured");
  const body: Record<string, unknown> = {
    channel: args.channelId,
    text: args.text,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (args.threadTs) body.thread_ts = args.threadTs;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!j.ok) throw new Error(j.error ?? "chat.postMessage failed");
  return { ts: j.ts ?? null };
}

function companyLabel(c: Customer): string {
  return c.company_name ?? c.workspace_name ?? "an account";
}

function csmMention(c: Customer, settings: SettingsShape): string {
  const handle = c.customer_success_manager;
  if (!handle) return "the CSM";
  const slackId = settings.slack.csm_user_ids[handle];
  if (slackId) return `<@${slackId}>`;
  return handle.replace(/_/g, " ");
}

function dashboardOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app"
  ).replace(/\/+$/, "");
}

function customerDeepLink(c: Customer): string {
  const origin = dashboardOrigin();
  const params = new URLSearchParams({ tab: "renewals" });
  if (c.workspace_id) params.set("workspace_id", c.workspace_id);
  return `${origin}/csm?${params.toString()}`;
}

function formatRenewalDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function utcYmd(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function buildKickoffMessage(
  c: Customer,
  settings: SettingsShape,
  renewalIso: string,
  lifecycleStage: string | null
): string {
  const mention = csmMention(c, settings);
  const arrLine = c.arr != null ? `${fmtCurrency(c.arr)}/yr` : "—";
  const stageLine = lifecycleStage ?? "—";
  const link = customerDeepLink(c);
  return [
    `:handshake: *Renewal kickoff — ${companyLabel(c)}*`,
    `• Plan: *${c.stripe_plan ?? "—"}*`,
    `• Current ARR: *${arrLine}*`,
    `• Lifecycle stage: *${stageLine}*`,
    `• Renewal date: *${formatRenewalDate(renewalIso)}*`,
    `• CSM: ${mention}`,
    ``,
    `Opening the pricing thread here so we track pacing in one place.`,
    `<${link}|Open in dashboard ↗>`,
  ].join("\n");
}

function buildMilestoneReply(
  c: Customer,
  settings: SettingsShape,
  milestone: Milestone,
  renewalIso: string,
  lifecycleStage: string | null
): string {
  const mention = csmMention(c, settings);
  const stageLine = lifecycleStage ?? "—";
  const link = customerDeepLink(c);
  const daysLine =
    milestone === 7
      ? `Only *7 days* until renewal on ${formatRenewalDate(renewalIso)}.`
      : `*${milestone} days* until renewal on ${formatRenewalDate(renewalIso)}.`;
  return [
    `:alarm_clock: ${daysLine} ${mention}`,
    `Current lifecycle stage: *${stageLine}*.`,
    `<${link}|Open in dashboard ↗>`,
  ].join("\n");
}

function todoTitleFor(
  c: Customer,
  milestone: Milestone
): string {
  const name = companyLabel(c);
  if (milestone === 90) return `Kick off renewal for ${name}`;
  if (milestone === 7) return `Renewal for ${name} lands in a week`;
  return `Check in on ${name} renewal (${milestone}d out)`;
}

function buildTodo(
  c: Customer,
  milestone: Milestone,
  renewalIso: string
): PersonalTodo {
  const now = new Date().toISOString();
  return {
    id: newTodoId(),
    title: todoTitleFor(c, milestone),
    details: null,
    due_date: utcYmd(renewalIso),
    surface_at: null,
    priority: milestone <= 30 ? "high" : "medium",
    source: "renewal_milestone",
    source_meta: {
      workspace_id: c.workspace_id ?? undefined,
      milestone_days: milestone,
    },
    completed_at: null,
    remind_via_slack: true,
    created_at: now,
    updated_at: now,
  };
}

export async function runRenewalMilestoneSweep(
  opts: SweepOpts = {}
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    fired: [],
    skipped: [],
    failures: [],
  };
  const now = opts.now ?? new Date();
  // `lifecycle_stage` lives on the customer-overrides KV overlay (not
  // on the Customer row itself — applyOverride doesn't project it),
  // so read the overlay separately and consult it per-workspace when
  // checking the terminal-stage exclusion.
  const [customers, overrides, settings] = await Promise.all([
    loadCustomers(),
    loadOverrides(),
    loadSettings(),
  ]);
  const channelId = settings.am?.renewals_slack_channel_id?.trim() ?? "";
  if (!channelId) {
    return {
      ...result,
      disabled: true,
      reason:
        "Renewals Slack channel isn't configured. Set it at /settings/slack → Renewals Slack channel.",
    };
  }
  const scope = opts.workspaceIds
    ? new Set(opts.workspaceIds.filter(Boolean))
    : null;

  for (const c of customers) {
    if (!c.workspace_id) continue;
    if (scope && !scope.has(c.workspace_id)) continue;
    if (intervalBucket(c) === "monthly") continue;
    const stage = overrides[c.workspace_id]?.lifecycle_stage?.trim() ?? null;
    if (stage && TERMINAL_STAGES.has(stage)) continue;
    if (!c.customer_success_manager) continue;
    const csmEmail = c.customer_success_manager_email;
    if (!csmEmail) continue;
    const renewalIso = nextRenewalDate(c);
    const daysUntil = daysUntilRenewal(renewalIso, now);
    if (renewalIso == null || daysUntil == null) continue;

    const renewalYmd = utcYmd(renewalIso);
    result.scanned++;

    for (const milestone of MILESTONES) {
      if (daysUntil !== milestone) continue;
      let alreadyFired = false;
      try {
        alreadyFired = await hasMilestoneFired(
          c.workspace_id,
          milestone,
          renewalYmd
        );
      } catch (e) {
        result.failures.push({
          workspace_id: c.workspace_id,
          milestone_days: milestone,
          error: e instanceof Error ? e.message : "hasMilestoneFired failed",
        });
        continue;
      }
      if (alreadyFired) {
        result.skipped.push({
          workspace_id: c.workspace_id,
          milestone_days: milestone,
          reason: "already fired for this renewal cycle",
        });
        continue;
      }

      try {
        const outcome = await fireMilestone({
          customer: c,
          milestone,
          renewalIso,
          renewalYmd,
          stage,
          settings,
          channelId,
          csmEmail,
          dryRun: opts.dryRun === true,
        });
        result.fired.push(outcome);
      } catch (e) {
        result.failures.push({
          workspace_id: c.workspace_id,
          milestone_days: milestone,
          error: e instanceof Error ? e.message : "fire failed",
        });
      }
    }
  }

  return result;
}

async function fireMilestone(args: {
  customer: Customer;
  milestone: Milestone;
  renewalIso: string;
  renewalYmd: string;
  stage: string | null;
  settings: SettingsShape;
  channelId: string;
  csmEmail: string;
  dryRun: boolean;
}): Promise<FireResult> {
  const {
    customer: c,
    milestone,
    renewalIso,
    renewalYmd,
    stage,
    settings,
    channelId,
    csmEmail,
    dryRun,
  } = args;
  const workspaceId = c.workspace_id!;

  let slackTs: string | null = null;
  let threadOpened = false;

  const existingThread = await getRenewalThread(workspaceId);
  if (milestone === 90 && !existingThread) {
    const kickoffText = buildRenewalKickoffMessage({
      customer: c,
      settings,
      renewalIso,
      lifecycleStage: stage,
    });
    const kickoffText = buildKickoffMessage(c, settings, renewalIso, stage);
    if (!dryRun) {
      const r = await postToSlack({ channelId, text: kickoffText });
      slackTs = r.ts;
      const rec: RenewalThreadRecord = {
        channel_id: channelId,
        thread_ts: r.ts ?? "",
        opened_by: "milestone_engine",
        opened_at: new Date().toISOString(),
        origin: "milestone_engine",
        kickoff_context: {
          workspace_id: workspaceId,
          workspace_name: c.workspace_name ?? undefined,
          lifecycle_stage: stage,
          renewal_date: renewalIso,
          arr: c.arr ?? null,
        },
      };
      await saveRenewalThreadIfAbsent(workspaceId, rec);
      threadOpened = true;
    } else {
      threadOpened = true;
    }
  } else if (existingThread || milestone !== 90) {
    const replyText = buildRenewalMilestoneReply({
      customer: c,
      settings,
      milestone,
      renewalIso,
      lifecycleStage: stage,
    });
    const replyText = buildMilestoneReply(c, settings, milestone, renewalIso, stage);
    const thread = existingThread ?? null;
    if (thread && thread.thread_ts) {
      if (!dryRun) {
        const r = await postToSlack({
          channelId: thread.channel_id,
          text: replyText,
          threadTs: thread.thread_ts,
        });
        slackTs = r.ts;
      }
    } else if (!thread) {
      if (!dryRun) {
        const text = buildRenewalKickoffMessage({
          customer: c,
          settings,
          renewalIso,
          lifecycleStage: stage,
          openedByLine: `_(auto-opened at the ${milestone}-day mark; no earlier pricing thread was found.)_`,
        });
        const text =
          buildKickoffMessage(c, settings, renewalIso, stage) +
          `\n\n_(auto-opened at the ${milestone}-day mark; no earlier pricing thread was found.)_`;
        const r = await postToSlack({ channelId, text });
        slackTs = r.ts;
        const rec: RenewalThreadRecord = {
          channel_id: channelId,
          thread_ts: r.ts ?? "",
          opened_by: "milestone_engine",
          opened_at: new Date().toISOString(),
          origin: "milestone_engine",
          kickoff_context: {
            workspace_id: workspaceId,
            workspace_name: c.workspace_name ?? undefined,
            lifecycle_stage: stage,
            renewal_date: renewalIso,
            arr: c.arr ?? null,
          },
        };
        await saveRenewalThreadIfAbsent(workspaceId, rec);
        threadOpened = true;
      } else {
        threadOpened = true;
      }
    }
  }

  let todoCreated = false;
  if (!dryRun) {
    const todo = buildTodo(c, milestone, renewalIso);
    await applyTodoOps(userKeyFromEmail(csmEmail), [{ type: "add", todo }]);
    todoCreated = true;

    await appendActionLog([
      {
        workspace_id: workspaceId,
        text: `Renewal milestone: ${milestone}d out`,
        action_kind: "renewal_milestone",
        metadata: {
          milestone_days: milestone,
          renewal_date: renewalIso,
          lifecycle_stage: stage,
          slack_ts: slackTs,
        },
      },
    ]);

    await markMilestoneFired({
      workspace_id: workspaceId,
      milestone_days: milestone,
      renewal_iso: renewalYmd,
      fired_at: new Date().toISOString(),
      slack_ts: slackTs,
    });
  }

  return {
    workspace_id: workspaceId,
    workspace_name: c.workspace_name ?? null,
    csm: c.customer_success_manager ?? null,
    milestone_days: milestone,
    renewal_iso: renewalYmd,
    slack_ts: slackTs,
    todo_created: todoCreated,
    thread_opened: threadOpened,
  };
}
