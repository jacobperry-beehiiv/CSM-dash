import type { FeatureUpdate } from "../feature-updates/types";
import { tsToMs } from "../feature-updates/types";

/**
 * Read-side Slack integration — pulls messages out of a channel and
 * resolves author names. Used by the feature-updates sync route.
 *
 * Requires bot scopes:
 *   • channels:history  (public channels)
 *   • groups:history    (only needed if the channel is private)
 *   • users:read        (resolve U-ids to display names)
 *   • chat:write        (already used elsewhere) — not needed here
 *
 * The bot must also be invited to the target channel
 * (`/invite @csm-dash-bot` from inside the channel) so it can read
 * history. Slack returns `not_in_channel` otherwise.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
  // Plus dozens of other fields we don't care about.
}

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface SlackUserResponse {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

interface SlackPermalinkResponse {
  ok: boolean;
  error?: string;
  permalink?: string;
}

function requireToken(): string {
  if (!SLACK_BOT_TOKEN) {
    throw new Error(
      "SLACK_BOT_TOKEN is not configured — set it in .env.local."
    );
  }
  return SLACK_BOT_TOKEN;
}

/**
 * One page-at-a-time pull through conversations.history, oldest=cursor.
 * Returns the messages newer than the cursor (Slack returns them
 * newest-first; we reverse to oldest-first so the merge step's "newest
 * ts wins" cursor logic is correct even on partial pages).
 *
 * Caps at `maxMessages` to keep sync runs bounded. Default 200 is
 * plenty for a channel that gets a handful of updates per week.
 */
export async function fetchChannelMessages(args: {
  channelId: string;
  oldestTs?: string | null;
  maxMessages?: number;
}): Promise<SlackMessage[]> {
  const token = requireToken();
  const cap = args.maxMessages ?? 200;
  const out: SlackMessage[] = [];
  let cursor: string | undefined;
  while (out.length < cap) {
    const params = new URLSearchParams({
      channel: args.channelId,
      limit: String(Math.min(100, cap - out.length)),
      inclusive: "false",
    });
    if (args.oldestTs) params.set("oldest", args.oldestTs);
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const json = (await res.json()) as SlackHistoryResponse;
    if (!json.ok) {
      throw new Error(
        `Slack conversations.history failed: ${json.error ?? "unknown"}`
      );
    }
    out.push(...(json.messages ?? []));
    if (!json.has_more || !json.response_metadata?.next_cursor) break;
    cursor = json.response_metadata.next_cursor;
  }
  // conversations.history returns newest-first; reverse so consumers
  // see oldest-first (easier to reason about cursor advancement).
  return out.reverse();
}

const userNameCache = new Map<string, string>();

/** Resolve a Slack user id to a display name, caching across calls
 *  within the same sync run. Returns "Unknown" on missing scope /
 *  deleted user / API failure — never throws. */
export async function fetchUserDisplayName(
  userId: string | null | undefined
): Promise<string> {
  if (!userId) return "Unknown";
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  const token = requireToken();
  try {
    const res = await fetch(
      `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const json = (await res.json()) as SlackUserResponse;
    if (!json.ok || !json.user) {
      userNameCache.set(userId, "Unknown");
      return "Unknown";
    }
    const name =
      json.user.profile?.display_name?.trim() ||
      json.user.profile?.real_name?.trim() ||
      json.user.real_name?.trim() ||
      "Unknown";
    userNameCache.set(userId, name);
    return name;
  } catch {
    userNameCache.set(userId, "Unknown");
    return "Unknown";
  }
}

/** Resolve a permalink to the original message. Optional — we degrade
 *  to null on failure so a permalink miss doesn't block the sync. */
async function fetchPermalink(args: {
  channel: string;
  ts: string;
}): Promise<string | null> {
  const token = requireToken();
  try {
    const params = new URLSearchParams({
      channel: args.channel,
      message_ts: args.ts,
    });
    const res = await fetch(
      `https://slack.com/api/chat.getPermalink?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const json = (await res.json()) as SlackPermalinkResponse;
    if (!json.ok) return null;
    return json.permalink ?? null;
  } catch {
    return null;
  }
}

/**
 * Filter + map raw Slack messages into the shape we persist. Drops:
 *   - Join/leave/channel-meta subtypes (channel_join, channel_purpose,
 *     channel_topic, etc.) — Slack tags those with a `subtype` field.
 *   - Bot/integration posts unless they have visible text — the
 *     channel-name convention is human "feature update" posts, but a
 *     bot-driven release-notes integration is plausible later, so we
 *     keep bot messages whose `text` actually contains something.
 *   - Pure-attachment messages with no text — nothing to display in
 *     the panel.
 */
export async function pullFeatureUpdates(args: {
  channelId: string;
  oldestTs?: string | null;
  maxMessages?: number;
}): Promise<FeatureUpdate[]> {
  const raw = await fetchChannelMessages(args);

  // Filter to "real" messages with displayable text.
  const filtered = raw.filter((m) => {
    if (!m.text || !m.text.trim()) return false;
    if (m.subtype && m.subtype !== "bot_message" && m.subtype !== "thread_broadcast") {
      // channel_join, channel_leave, channel_topic, channel_purpose,
      // pinned_item, etc. — all noise.
      return false;
    }
    return true;
  });

  // Resolve author display names + permalinks in parallel per message.
  // Each users.info / chat.getPermalink call is ~50ms; doing them
  // serially would slow a 50-message backfill down a lot.
  const enriched = await Promise.all(
    filtered.map(async (m) => {
      const author_user_id = m.user ?? null;
      const [author_name, permalink] = await Promise.all([
        author_user_id
          ? fetchUserDisplayName(author_user_id)
          : Promise.resolve(m.username ?? "Slack bot"),
        fetchPermalink({ channel: args.channelId, ts: m.ts }),
      ]);
      const out: FeatureUpdate = {
        id: m.ts,
        channel_id: args.channelId,
        author_user_id,
        author_name,
        text: m.text ?? "",
        posted_at_ms: tsToMs(m.ts),
        permalink,
      };
      return out;
    })
  );
  return enriched;
}
