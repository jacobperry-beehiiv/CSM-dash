import type { Customer } from "../types";
import { isEnterprise, loadCustomers } from "../data/load-customers";
import {
  loadProactiveOutreach,
  savePingSent,
  saveNudgeSent,
  type ProactiveOutreachEntry,
} from "../data/proactive-outreach";
import { loadSettings } from "../data/settings";
import {
  findSlackChannel,
  PROACTIVE_OUTREACH_CHANNEL_ID,
  type SettingsShape,
} from "../data/settings-types";
import { fmtCurrency } from "../../components/format";
import {
  buildRollupTokens,
  DEFAULT_ROLLUP_TEMPLATE,
  renderRollupTemplate,
} from "../integrations/slack-rollup";

/**
 * Phase 2b sweep — fires Slack alerts when an Enterprise account
 * first crosses the sub-cap threshold, and nudges AM after N days
 * of no logged outreach. Idempotent: re-running within minutes does
 * nothing because every emission is guarded by a KV dedupe key.
 */

// Matches ENT_UTIL_THRESHOLD on the AM page — Enterprise account is
// "approaching cap" once it crosses 75% of the configured sub limit.
const UTIL_THRESHOLD = 0.75;
const NUDGE_AFTER_DAYS = 5;
const NUDGE_REPEAT_DAYS = 5;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

interface SweepResult {
  scanned: number;
  pings_sent: number;
  nudges_sent: number;
  skipped_no_workspace: number;
  skipped_already_pinged: number;
  skipped_outreach_logged: number;
  skipped_recent_nudge: number;
  failures: { workspace: string; error: string }[];
}

function utilPct(c: Customer): number | null {
  if (c.percent_of_max_subs != null) {
    return c.percent_of_max_subs > 1
      ? c.percent_of_max_subs / 100
      : c.percent_of_max_subs;
  }
  if (c.active_subs != null && c.max_subscriptions) {
    return c.active_subs / c.max_subscriptions;
  }
  return null;
}

function billLabel(c: Customer): string {
  const interval = (c.interval ?? "").toLowerCase();
  if (interval === "month" || interval === "monthly") {
    return `${fmtCurrency(c.mrr)}/mo`;
  }
  return `${fmtCurrency(c.arr)}/yr`;
}

function csmTag(c: Customer, settings: SettingsShape): string {
  const handle = c.customer_success_manager;
  if (!handle) return "unassigned";
  const slackId = settings.slack.csm_user_ids[handle];
  if (slackId) return `<@${slackId}>`;
  return handle.replace(/_/g, " ");
}

function renderPing(
  template: string,
  c: Customer,
  settings: SettingsShape
): string {
  const util = utilPct(c);
  const values: Record<string, string> = {
    company_name: c.company_name ?? c.workspace_name ?? "—",
    workspace_name: c.workspace_name ?? "—",
    tier: c.stripe_plan ?? "—",
    active_subs: c.active_subs != null ? c.active_subs.toLocaleString() : "—",
    max_subs:
      c.max_subscriptions != null
        ? c.max_subscriptions.toLocaleString()
        : "—",
    util_pct: util != null ? `${(util * 100).toFixed(0)}%` : "—",
    bill: billLabel(c),
    csm: csmTag(c, settings),
    arr: fmtCurrency(c.arr),
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) =>
    name in values ? values[name] : ""
  );
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

export async function runProactiveOutreachSweep(
  opts: {
    dryRun?: boolean;
    /**
     * Optional whitelist of workspace_ids to scope the sweep to. When
     * set, only customers in this list are evaluated — useful for the
     * manual UI trigger where the AM has hand-picked which accounts to
     * ping. When unset (the cron path), the engine scans the full
     * eligible Enterprise ≥cap cohort as before.
     */
    workspaceIds?: string[];
    /**
     * Where this sweep was triggered from. "cron" is the daily GitHub
     * Actions schedule; "manual" is an admin clicking the panel
     * button. The `am.proactive_outreach_sweep_enabled` toggle in
     * /settings/slack gates "cron" only — manual sweeps always run
     * so admins can ping on-demand even when the schedule is paused.
     * Defaults to "cron" to keep the safer-by-default behavior for
     * callers that haven't been updated yet.
     */
    triggeredBy?: "cron" | "manual";
  } = {}
): Promise<SweepResult & { disabled?: boolean; reason?: string }> {
  const result: SweepResult = {
    scanned: 0,
    pings_sent: 0,
    nudges_sent: 0,
    skipped_no_workspace: 0,
    skipped_already_pinged: 0,
    skipped_outreach_logged: 0,
    skipped_recent_nudge: 0,
    failures: [],
  };

  const [customers, state, settings] = await Promise.all([
    loadCustomers(),
    loadProactiveOutreach(),
    loadSettings(),
  ]);

  // Schedule gate — only applies to cron-triggered runs. Manual sweeps
  // ignore the toggle so an admin can ping on-demand even while the
  // schedule is paused (the original intent of the toggle is "stop
  // the daily auto-pings without nuking the engine entirely").
  const triggeredBy = opts.triggeredBy ?? "cron";
  if (
    triggeredBy === "cron" &&
    settings.am?.proactive_outreach_sweep_enabled === false
  ) {
    return {
      ...result,
      disabled: true,
      reason:
        "Scheduled sweep is disabled in settings (am.proactive_outreach_sweep_enabled = false). Flip the toggle on /settings/slack to resume.",
    };
  }

  const channelCfg = findSlackChannel(
    settings.slack,
    PROACTIVE_OUTREACH_CHANNEL_ID
  );
  if (!channelCfg?.channel_id) {
    throw new Error(
      "Proactive Outreach Slack channel isn't configured. Set it at /settings/slack (channel id `proactive_outreach`)."
    );
  }
  // Per-CSM rollup is now the default — the engine groups eligible
  // accounts by owner and sends ONE message per CSM with the count
  // + filtered deep link, instead of one message per company. The
  // legacy per-company `channelCfg.template` is now unused for the
  // ping path (kept on the channel config since the type still has
  // it; clearing it no longer breaks the sweep). Nudges (below)
  // still thread per-account because they're follow-ups on a
  // specific row's stalled outreach.
  const rollupTemplate =
    (channelCfg.rollup_template ?? "").trim() || DEFAULT_ROLLUP_TEMPLATE;
  // Deep link base for the {{filtered_url}} / {{filtered_link}}
  // tokens. Uses NEXT_PUBLIC_DASHBOARD_URL to match the convention
  // every other server-side Slack writer in this codebase already
  // follows (team-tasks reminders, personal-todo reminders,
  // slack-views) — and falls back to the prod origin so a deploy
  // without the env var still emits clickable links. Without an
  // absolute URL Slack drops the link entirely (renders the bare
  // path inside the angle brackets), which was the visible bug.
  const dashboardOrigin = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app"
  ).replace(/\/+$/, "");
  const proactiveDeepLink = `${dashboardOrigin}/am?tab=proactive`;

  // Eligible cohort: Enterprise, ≥75% of cap, with a workspace_id to
  // key dedupe state on. Falls into the same definition the panel uses.
  //
  // When the caller passed a workspaceIds whitelist, narrow to that
  // set BEFORE applying the threshold check — gives the AM control
  // even if a row's percentage flickers around the cap on a given
  // q10600 snapshot, while still skipping rows that are clearly far
  // below the threshold (defensive: a typo'd workspace_id from the
  // UI shouldn't ping a random low-util customer).
  const scope = opts.workspaceIds
    ? new Set(opts.workspaceIds.filter(Boolean))
    : null;
  const eligible = customers.filter((c) => {
    if (scope && (!c.workspace_id || !scope.has(c.workspace_id))) return false;
    if (!isEnterprise(c)) return false;
    const u = utilPct(c);
    return u != null && u >= UTIL_THRESHOLD;
  });

  // Group by CSM before iterating so the Slack channel reads as
  // contiguous blocks per owner (Olivia's accounts in a row, then
  // Jacob's, …) rather than interleaved. Easier to triage in Slack
  // — a CSM scanning the channel sees their accounts together.
  //
  // Tie-breakers within a CSM: highest utilization first so the
  // most-urgent account in each block leads. Unassigned rows sort
  // to the end so they don't pollute the named-CSM blocks.
  eligible.sort((a, b) => {
    const aCsm = a.customer_success_manager ?? "￿"; // unassigned to end
    const bCsm = b.customer_success_manager ?? "￿";
    if (aCsm !== bCsm) return aCsm.localeCompare(bCsm);
    const au = utilPct(a) ?? 0;
    const bu = utilPct(b) ?? 0;
    return bu - au;
  });

  const now = Date.now();

  // ── First-time pings: group by CSM, send one rollup per CSM ──
  // Build the to-ping cohort first (skip already-pinged / workspace-
  // less rows so the rollup count matches reality). Then bucket by
  // CSM handle and emit a single Slack message per bucket using the
  // configured rollup_template. Every account in a bucket still gets
  // an individual savePingSent() call so the per-account dedupe +
  // nudge thread state stays correct — they all share the rollup's
  // Slack ts so nudges thread under the rollup message later.
  const toPing: Customer[] = [];
  for (const c of eligible) {
    result.scanned++;
    if (!c.workspace_id) {
      result.skipped_no_workspace++;
      continue;
    }
    const entry: ProactiveOutreachEntry | undefined = state[c.workspace_id];
    if (!entry || !entry.ping_sent_at) {
      toPing.push(c);
    }
  }

  // Group the ping cohort by CSM handle. Unassigned rows bucket into
  // one "Unassigned" group (key __unassigned__) so they still get a
  // rollup ping in the channel — there's no Slack ID to @-mention so
  // the template's {{csm_mention}} falls back to plain "Unassigned".
  const pingGroups = new Map<string, Customer[]>();
  for (const c of toPing) {
    const key = c.customer_success_manager ?? "__unassigned__";
    const list = pingGroups.get(key) ?? [];
    list.push(c);
    pingGroups.set(key, list);
  }
  for (const [key, group] of pingGroups.entries()) {
    const handle = key === "__unassigned__" ? null : key;
    const slackId = handle ? settings.slack.csm_user_ids[handle] ?? null : null;
    const tokens = buildRollupTokens({
      csmHandle: handle,
      csmSlackId: slackId,
      count: group.length,
      rollupNoun: "accounts",
      rollupContext: "proactive outreach",
      deepLinkBase: proactiveDeepLink,
    });
    const text = renderRollupTemplate(rollupTemplate, tokens);
    try {
      let messageTs: string | null = null;
      if (!opts.dryRun) {
        const r = await postToSlack({
          channelId: channelCfg.channel_id,
          text,
        });
        messageTs = r.ts;
        // Stamp every account in the group as pinged. They share the
        // rollup's Slack ts so nudges in this same engine run thread
        // under the rollup message instead of starting a new top-
        // level conversation.
        for (const c of group) {
          if (c.workspace_id) {
            await savePingSent(c.workspace_id, { messageTs });
          }
        }
      }
      // Count one "ping" per account so the existing UI counter
      // ("pinged N") keeps reading correctly. Counting per-group
      // would be misleading — the CSMs care about how many of their
      // accounts moved into the pinged state.
      result.pings_sent += group.length;
    } catch (e) {
      // Roll the whole group's failures up — the rollup message
      // either landed or didn't, so per-account failure attribution
      // doesn't add information here.
      result.failures.push({
        workspace: handle
          ? `${handle} (${group.length} accounts)`
          : `Unassigned (${group.length} accounts)`,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  // ── Nudges: still per-account, threaded under the original ping ──
  // Iterate the original eligible list so we evaluate every row that
  // already has a ping_sent_at against the nudge thresholds.
  for (const c of eligible) {
    if (!c.workspace_id) continue;
    const entry: ProactiveOutreachEntry | undefined = state[c.workspace_id];
    if (!entry || !entry.ping_sent_at) continue; // not yet pinged

    // Outreach already logged — nothing to nudge about.
    if (entry.last_outreach_at) {
      result.skipped_outreach_logged++;
      continue;
    }

    // Eligible for nudge? Need N days since ping AND either no prior
    // nudge OR last nudge was N days ago.
    const daysSincePing =
      (now - new Date(entry.ping_sent_at).getTime()) / MS_PER_DAY;
    if (daysSincePing < NUDGE_AFTER_DAYS) {
      result.skipped_already_pinged++;
      continue;
    }
    if (entry.last_nudge_at) {
      const daysSinceLastNudge =
        (now - new Date(entry.last_nudge_at).getTime()) / MS_PER_DAY;
      if (daysSinceLastNudge < NUDGE_REPEAT_DAYS) {
        result.skipped_recent_nudge++;
        continue;
      }
    }

    // Fire the nudge — threaded under the original ping if we have
    // its ts so the channel doesn't get a fresh top-level message.
    try {
      const nudgeText = `:hourglass_flowing_sand: Heads-up — still no logged outreach for *${
        c.company_name ?? c.workspace_name ?? c.workspace_id
      }* after ${Math.round(daysSincePing)} days. Worth a follow-up.`;
      if (!opts.dryRun) {
        await postToSlack({
          channelId: channelCfg.channel_id,
          text: nudgeText,
          threadTs: entry.ping_message_ts ?? undefined,
        });
        await saveNudgeSent(c.workspace_id);
      }
      result.nudges_sent++;
    } catch (e) {
      result.failures.push({
        workspace: c.workspace_name ?? c.workspace_id,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  return result;
}
