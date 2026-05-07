import type {
  AtRiskRunResult,
} from "../engines/at-risk";
import type { DeliverabilityRunResult } from "../engines/deliverability";

/**
 * Thin Slack integration — used by cron routes to post summary
 * messages. Safe to skip: if SLACK_BOT_TOKEN is not set, these
 * functions no-op and the cron still succeeds.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.SLACK_DELIVERABILITY_CHANNEL;

async function slackPost(channel: string, text: string, blocks?: unknown[]) {
  if (!SLACK_BOT_TOKEN) {
    throw new Error(
      "SLACK_BOT_TOKEN is not configured — set it in .env.local."
    );
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, blocks }),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack post failed: ${data.error}`);
  }
}

/** Generic message sender used by the Past-Due Slack alert flow. */
export async function postSlackMessage(args: {
  channel: string;
  text: string;
}): Promise<{ ok: true }> {
  if (!args.channel) {
    throw new Error("Slack channel is required.");
  }
  await slackPost(args.channel, args.text);
  return { ok: true };
}

export async function postDeliverabilityAlerts(
  result: DeliverabilityRunResult
): Promise<void> {
  if (!SLACK_BOT_TOKEN || !CHANNEL) return;
  if (result.alerts.length === 0) {
    await slackPost(
      CHANNEL,
      `:white_check_mark: Deliverability check — ${result.target_date} — no red flags for ${result.csm_name ?? "all CSMs"} (${result.total_posts_yesterday} posts analyzed).`
    );
    return;
  }

  const header = `:rotating_light: *Deliverability alerts — ${result.target_date}* (${result.alerts.length} flagged / ${result.total_posts_yesterday} posts)`;
  const lines = result.alerts.slice(0, 10).map((a) => {
    const critCount = a.flags.filter((f) => f.severity === "critical").length;
    const severity = critCount > 0 ? ":red_circle:" : ":warning:";
    const topFlag = a.flags[0];
    return `${severity} *${a.post.workspace_name}* — ${a.post.newsletter}: ${topFlag.message}`;
  });
  await slackPost(CHANNEL, header, [
    {
      type: "section",
      text: { type: "mrkdwn", text: [header, ...lines].join("\n") },
    },
  ]);
}

export async function postAtRiskSummary(result: AtRiskRunResult): Promise<void> {
  if (!SLACK_BOT_TOKEN || !CHANNEL) return;
  const header = `:chart_with_upwards_trend: *Weekly at-risk — ${result.csm_name ?? "all"}* — ${result.accounts.length} accounts flagged (of ${result.total_in_book} in book)`;
  const top = result.accounts.slice(0, 10).map((a) => {
    const flagLabels = a.flags.map((f) => f.code).join("");
    return `• [${flagLabels}] *${a.customer.company_name ?? a.customer.workspace_name}* — ${a.recommended_action}`;
  });
  await slackPost(CHANNEL, header, [
    {
      type: "section",
      text: { type: "mrkdwn", text: [header, ...top].join("\n") },
    },
  ]);
}
