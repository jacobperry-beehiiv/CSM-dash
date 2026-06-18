import type {
  AtRiskRunResult,
} from "../engines/at-risk";
import type { DeliverabilityRunResult } from "../engines/deliverability";
import { isDemoMode } from "../demo/mode";

/**
 * Thin Slack integration — used by cron routes to post summary
 * messages. Safe to skip: if SLACK_BOT_TOKEN is not set, these
 * functions no-op and the cron still succeeds.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.SLACK_DELIVERABILITY_CHANNEL;

async function slackPost(channel: string, text: string, blocks?: unknown[]) {
  // Demo-mode write guard. Same intent as kvSet's guard — even if a
  // route fires a Slack notification, suppress it in DEMO_MODE so a
  // screenshot session can't blast real channels with fake content.
  if (isDemoMode()) {
    console.log(
      `[demo-mode] suppressed Slack post → ${channel}: ${text.slice(0, 120)}`
    );
    return;
  }
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

/**
 * Richer sender that returns the message ts. Needed by the review-
 * digest flow so per-account replies can be threaded under the parent
 * "you have N accounts" message. Also accepts blocks (Block Kit) and
 * thread_ts so this same helper can post both the parent and the
 * threaded children.
 *
 * Demo-mode guard: returns a fake ts so caller code that chains
 * replies under the returned ts doesn't crash. The downstream call is
 * also demo-guarded so the chain is fully suppressed.
 */
export async function postSlackMessageRich(args: {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}): Promise<{ ok: true; ts: string }> {
  if (!args.channel) {
    throw new Error("Slack channel is required.");
  }
  if (isDemoMode()) {
    console.log(
      `[demo-mode] suppressed Slack post → ${args.channel}: ${args.text.slice(0, 120)}`
    );
    return { ok: true, ts: "demo.000000" };
  }
  if (!SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not configured — set it in .env.local.");
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channel,
      text: args.text,
      blocks: args.blocks,
      thread_ts: args.thread_ts,
    }),
  });
  const data = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
  if (!data.ok || !data.ts) {
    throw new Error(`Slack post failed: ${data.error ?? "unknown"}`);
  }
  return { ok: true, ts: data.ts };
}

export async function postDeliverabilityAlerts(
  result: DeliverabilityRunResult
): Promise<void> {
  if (!SLACK_BOT_TOKEN || !CHANNEL) return;
  // `result.alerts` now contains ALL posts in the CSM's book (clean +
  // flagged) so the dashboard can render a full sweep. The Slack
  // channel is still alarms-only, so we filter to flagged here.
  const flagged = result.alerts.filter((a) => a.flags.length > 0);
  if (flagged.length === 0) {
    await slackPost(
      CHANNEL,
      `:white_check_mark: Deliverability check — ${result.target_date} — no red flags for ${result.csm_name ?? "all CSMs"} (${result.total_posts_yesterday} posts analyzed).`
    );
    return;
  }

  const header = `:rotating_light: *Deliverability alerts — ${result.target_date}* (${flagged.length} flagged / ${result.total_posts_yesterday} posts)`;
  const lines = flagged.slice(0, 10).map((a) => {
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

/** Slack's canonical channel-ID regex. completeUploadExternal +
 *  conversations.* endpoints enforce this strictly; chat.postMessage
 *  is lenient and accepts a name (with or without `#`), which is
 *  why admins occasionally configure a name and only learn it's
 *  invalid when a screenshot upload fails. */
export const SLACK_CHANNEL_ID_RE = /^[CGDZ][A-Z0-9]{8,}$/;

/** Slack user-ID prefix. When an admin configures the "channel" with
 *  a user ID by mistake ("send me a DM"), the resolver opens a DM
 *  channel and uses the returned channel ID instead. */
export const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{8,}$/;

const channelNameCache = new Map<string, { expires: number; id: string | null }>();
const CHANNEL_RESOLVE_TTL_MS = 5 * 60 * 1000;

/**
 * Best-effort name → ID resolver for places that need the canonical
 * channel ID (like files.completeUploadExternal). Returns the input
 * unchanged when it already matches the regex. When it doesn't, calls
 * conversations.list to find a channel with that name and returns
 * its `id`. Strips a leading `#` to be forgiving about how admins
 * type the name in settings.
 *
 * Cached for 5 minutes per query so a misbehaving channel doesn't
 * hammer Slack on every report-issue post.
 *
 * Requires the bot to have `channels:read` (public channels) and/or
 * `groups:read` (private channels) scope. Throws when the lookup
 * fails — the caller can decide whether that's fatal.
 */
export async function resolveSlackChannelId(
  raw: string
): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (SLACK_CHANNEL_ID_RE.test(trimmed)) return trimmed;
  if (!SLACK_BOT_TOKEN) return null;

  // User ID → open a DM with that user, use the resulting channel ID.
  // Only needs `im:write` scope (which most bots already have for
  // chat.postMessage to users), unlike the channels:read path below.
  if (SLACK_USER_ID_RE.test(trimmed)) {
    const cacheKey = `user:${trimmed}`;
    const cached = channelNameCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.id;
    const res = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ users: trimmed }),
    });
    const j = (await res.json()) as {
      ok: boolean;
      error?: string;
      channel?: { id?: string };
    };
    if (!j.ok || !j.channel?.id) {
      throw new Error(
        `conversations.open for user ${trimmed}: ${j.error ?? "unknown"} — the bot may need im:write scope, or the user may have DMs from apps disabled.`
      );
    }
    channelNameCache.set(cacheKey, {
      expires: Date.now() + CHANNEL_RESOLVE_TTL_MS,
      id: j.channel.id,
    });
    return j.channel.id;
  }

  const wanted = trimmed.replace(/^#/, "").toLowerCase();
  const cacheKey = `name:${wanted}`;
  const cached = channelNameCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.id;

  let cursor: string | undefined;
  // Walk paginated conversations.list looking for an exact name match.
  // Most workspaces have a few hundred channels; we cap at 5 pages
  // (~5000 channels) to avoid runaway loops on huge workspaces.
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      limit: "1000",
      exclude_archived: "true",
      // Include both public + private channels so the bot can resolve
      // either kind. Requires both channels:read AND groups:read.
      types: "public_channel,private_channel",
    });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(
      `https://slack.com/api/conversations.list?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      }
    );
    const j = (await res.json()) as {
      ok: boolean;
      error?: string;
      channels?: Array<{ id: string; name: string }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!j.ok) {
      // Don't poison the cache — transient errors should retry on the
      // next attempt rather than serve `null` for 5 minutes.
      throw new Error(`conversations.list: ${j.error ?? "unknown"}`);
    }
    const hit = (j.channels ?? []).find(
      (c) => c.name.toLowerCase() === wanted
    );
    if (hit) {
      channelNameCache.set(cacheKey, {
        expires: Date.now() + CHANNEL_RESOLVE_TTL_MS,
        id: hit.id,
      });
      return hit.id;
    }
    cursor = j.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  // No match found — cache the null result so we don't re-list on
  // every upload attempt for a misconfigured channel.
  channelNameCache.set(cacheKey, {
    expires: Date.now() + CHANNEL_RESOLVE_TTL_MS,
    id: null,
  });
  return null;
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
