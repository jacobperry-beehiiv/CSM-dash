import { loadSettings } from "../data/settings";
import {
  loadDeliverabilitySlackNotified,
  markDeliverabilitySlackNotified,
} from "../data/deliverability-slack-notified";
import { resolveSlackNotificationPref } from "../data/settings-types";
import { postSlackMessage, resolveSlackChannelId } from "../integrations/slack";
import { runDeliverabilityCheck } from "./deliverability";
import type { DeliverabilityAlert } from "../types";

/**
 * Scheduled + manual sweep for critical deliverability Slack pings.
 * Fires once per uncleared critical post (KV dedupe), respecting
 * /settings/slack notification preferences.
 */

export interface DeliverabilitySlackSweepResult {
  generated_at: string;
  dry_run: boolean;
  disabled?: boolean;
  reason?: string;
  target_date: string;
  critical_seen: number;
  already_notified: number;
  messages_sent: number;
  messages_failed: number;
  failures: Array<{ post_id: string; error: string }>;
  /** Post IDs that would have / did notify. */
  notified_post_ids: string[];
}

function dashboardBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ??
    process.env.DASHBOARD_BASE_URL ??
    "https://csm-dash.vercel.app"
  ).replace(/\/$/, "");
}

function csmMention(
  csm: string | null,
  csmUserIds: Record<string, string>
): string {
  if (!csm) return "unassigned";
  const slackId = csmUserIds[csm];
  if (slackId) return `<@${slackId}>`;
  return csm.replace(/_/g, " ");
}

function isCriticalUncleared(alert: DeliverabilityAlert): boolean {
  if (alert.cleared) return false;
  return alert.flags.some((f) => f.severity === "critical");
}

function renderCriticalLine(
  alert: DeliverabilityAlert,
  csmUserIds: Record<string, string>
): string {
  const topCritical =
    alert.flags.find((f) => f.severity === "critical") ?? alert.flags[0];
  const csm = csmMention(alert.csm, csmUserIds);
  return (
    `:red_circle: *${alert.post.workspace_name}* — ${alert.post.newsletter}\n` +
    `   ${topCritical?.message ?? "Critical flag"} · sent ${alert.post.sent_date} · CSM: ${csm}`
  );
}

export async function runDeliverabilitySlackSweep(args: {
  dryRun?: boolean;
  triggeredBy: "cron" | "manual";
}): Promise<DeliverabilitySlackSweepResult> {
  const dryRun = Boolean(args.dryRun);
  const settings = await loadSettings();
  const pref = resolveSlackNotificationPref(settings, "deliverability_critical");

  const envFallback = process.env.SLACK_DELIVERABILITY_CHANNEL?.trim() ?? "";
  const destination = pref.destination || envFallback;

  if (!pref.enabled || !destination) {
    return {
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
      disabled: true,
      reason: !pref.enabled
        ? "deliverability_critical notifications disabled in settings"
        : "no Slack destination configured",
      target_date: "",
      critical_seen: 0,
      already_notified: 0,
      messages_sent: 0,
      messages_failed: 0,
      failures: [],
      notified_post_ids: [],
    };
  }

  if (args.triggeredBy === "cron" && pref.cron_enabled === false) {
    return {
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
      disabled: true,
      reason: "scheduled deliverability_critical sweep disabled in settings",
      target_date: "",
      critical_seen: 0,
      already_notified: 0,
      messages_sent: 0,
      messages_failed: 0,
      failures: [],
      notified_post_ids: [],
    };
  }

  const result = await runDeliverabilityCheck({ csmName: null });
  const criticalAlerts = result.alerts.filter(isCriticalUncleared);
  const notifiedMap = await loadDeliverabilitySlackNotified();

  const toNotify = criticalAlerts.filter((a) => !notifiedMap[a.post.post_id]);
  const alreadyNotified = criticalAlerts.length - toNotify.length;

  const sweep: DeliverabilitySlackSweepResult = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    target_date: result.target_date,
    critical_seen: criticalAlerts.length,
    already_notified: alreadyNotified,
    messages_sent: 0,
    messages_failed: 0,
    failures: [],
    notified_post_ids: [],
  };

  if (toNotify.length === 0) return sweep;

  const channelId = await resolveSlackChannelId(destination);
  if (!channelId) {
    return {
      ...sweep,
      disabled: true,
      reason: `could not resolve Slack destination "${destination}"`,
    };
  }

  const dashUrl = `${dashboardBaseUrl()}/csm?tab=deliverability`;
  const header = `:rotating_light: *Critical deliverability* — ${result.target_date} (${toNotify.length} new)`;
  const lines = toNotify.map((a) =>
    renderCriticalLine(a, settings.slack.csm_user_ids)
  );
  const text = [
    header,
    ...lines,
    "",
    `<${dashUrl}|Open deliverability tab ↗>`,
  ].join("\n");

  if (dryRun) {
    sweep.notified_post_ids = toNotify.map((a) => a.post.post_id);
    return sweep;
  }

  try {
    await postSlackMessage({ channel: channelId, text });
    sweep.messages_sent = 1;
    const postIds = toNotify.map((a) => a.post.post_id);
    await markDeliverabilitySlackNotified(postIds);
    sweep.notified_post_ids = postIds;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    sweep.messages_failed = 1;
    sweep.failures.push({ post_id: toNotify[0]?.post.post_id ?? "", error: message });
  }

  return sweep;
}
