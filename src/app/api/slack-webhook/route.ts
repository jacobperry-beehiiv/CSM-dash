import { NextResponse } from "next/server";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadSettings } from "@/lib/data/settings";
import { applyTodoOps } from "@/lib/personal-todos/store";
import { userKeyFromSlackUserId } from "@/lib/personal-todos/identity";
import {
  newTodoId,
  type PersonalTodo,
  type TodoSource,
} from "@/lib/personal-todos/types";
import {
  getBotUserId,
  parseSlashTodoText,
  verifySlackSignature,
  type SlackEvent,
  type SlackEventEnvelope,
  type SlackSlashCommand,
  type UrlVerification,
} from "@/lib/integrations/slack-inbound";
import { DEFAULT_TODO_TRIGGER_EMOJI } from "@/lib/data/settings-types";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/slack-webhook
 *
 * Single inbound surface for the personal-todos feature. Handles:
 *
 *   - URL verification handshake (one-time, when an admin configures
 *     the event-subscriptions request URL in the Slack app).
 *   - Slash commands (`/todo …`) — Slack POSTs application/x-www-form-
 *     urlencoded.
 *   - Event subscriptions (`message.im`, `reaction_added`) — Slack
 *     POSTs JSON.
 *
 * Every request is signature-verified against `SLACK_SIGNING_SECRET`
 * with a 5-minute replay window. Missing/invalid → 401 (don't leak
 * whether the secret is misconfigured vs. tampered with).
 *
 * Slack expects a 200 within 3 seconds for events; we do the cheap
 * stuff (KV write, sometimes a Slack lookup) synchronously since it
 * fits easily, and ack right after.
 */

export async function POST(req: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json(
      {
        error:
          "SLACK_SIGNING_SECRET not configured. Set it in Vercel env vars (copy from Slack app → Basic Information → Signing Secret) so inbound webhooks can be verified.",
      },
      { status: 503 }
    );
  }

  // Read the body ONCE as raw text — verification needs the exact bytes.
  const rawBody = await req.text();
  const verified = verifySlackSignature({
    rawBody,
    signatureHeader: req.headers.get("x-slack-signature"),
    timestampHeader: req.headers.get("x-slack-request-timestamp"),
    signingSecret,
  });
  if (!verified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const parsed = JSON.parse(rawBody) as
        | UrlVerification
        | SlackEventEnvelope;
      if (parsed.type === "url_verification") {
        // The challenge handshake. Slack's docs say either JSON or
        // plain text works as long as the challenge value is echoed.
        return NextResponse.json({ challenge: parsed.challenge });
      }
      if (parsed.type === "event_callback") {
        await handleEvent(parsed.event);
        // ACK fast — any further work happens asynchronously in
        // future iterations if it gets heavy.
        return NextResponse.json({ ok: true });
      }
      // Unknown JSON shape — ACK so Slack doesn't retry, but log.
      console.warn("[slack-webhook] Unknown JSON payload shape", parsed);
      return NextResponse.json({ ok: true });
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawBody);
      const slash: SlackSlashCommand = {
        command: params.get("command") ?? "",
        text: params.get("text") ?? "",
        user_id: params.get("user_id") ?? "",
        user_name: params.get("user_name") ?? "",
        channel_id: params.get("channel_id") ?? "",
        response_url: params.get("response_url") ?? "",
        trigger_id: params.get("trigger_id") ?? "",
      };
      return await handleSlashCommand(slash);
    }

    return NextResponse.json(
      { error: `Unsupported content-type: ${contentType}` },
      { status: 400 }
    );
  } catch (e) {
    console.error("[slack-webhook] Handler error", e);
    // Still ACK 200 to Slack to suppress retries — the error is on us,
    // retrying won't help. Surface the message in our logs.
    return NextResponse.json({ ok: true, error: String(e) });
  }
}

// ─── Slash command ────────────────────────────────────────────────────

async function handleSlashCommand(
  slash: SlackSlashCommand
): Promise<NextResponse> {
  if (slash.command !== "/todo") {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `Unknown command: ${slash.command}`,
    });
  }
  const userKey = await resolveUserKeyForSlackId(slash.user_id);
  if (!userKey) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `Couldn't match your Slack ID (${slash.user_id}) to a CSM in the dashboard. Ask an admin to map you at /settings/slack.`,
    });
  }
  const parsed = parseSlashTodoText(slash.text);
  if (!parsed.title) {
    return NextResponse.json({
      response_type: "ephemeral",
      text:
        "Add a title after `/todo` — e.g. `/todo Review Foo Co quarterly report`.\n" +
        "Optional directives: `on:YYYY-MM-DD` (schedule), `due:YYYY-MM-DD`, `!high|!medium|!low`.",
    });
  }
  const now = new Date().toISOString();
  const todo: PersonalTodo = {
    id: newTodoId(),
    title: parsed.title,
    details: null,
    due_date: parsed.due_date,
    surface_at: parsed.surface_at,
    priority: parsed.priority,
    source: "slack_slash",
    source_meta: { slack_user_id: slash.user_id },
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await applyTodoOps(userKey, [{ type: "add", todo }]);
  return NextResponse.json({
    response_type: "ephemeral",
    text: buildAddedAck(todo),
  });
}

// ─── Event subscriptions ──────────────────────────────────────────────

async function handleEvent(event: SlackEvent): Promise<void> {
  if (event.type === "message") {
    await handleDmMessage(event);
    return;
  }
  if (event.type === "reaction_added") {
    await handleReactionAdded(event);
    return;
  }
}

async function handleDmMessage(
  event: Extract<SlackEvent, { type: "message" }>
): Promise<void> {
  // Only DMs (im channels). Slack also fires for channel messages if
  // the bot is subscribed broadly — we ignore those.
  if (event.channel_type !== "im") return;
  // Drop message edits / deletions and any subtype that isn't a fresh
  // user message.
  if (event.subtype) return;
  // Drop the bot's own DMs back to the user.
  const botId = await getBotUserId();
  if (event.user && botId && event.user === botId) return;
  if (event.bot_id) return;
  if (!event.user || !event.text) return;

  const userKey = await resolveUserKeyForSlackId(event.user);
  if (!userKey) {
    // Friendly bounce — the user won't know why their DM didn't land.
    await ephemeralDm(
      event.user,
      `I couldn't match your Slack ID (${event.user}) to a CSM in the dashboard. Ask an admin to map you at /settings/slack.`
    );
    return;
  }
  const now = new Date().toISOString();
  const text = event.text.trim().slice(0, 500);
  const todo: PersonalTodo = {
    id: newTodoId(),
    title: text || "(empty DM)",
    details: null,
    due_date: null,
    surface_at: null,
    priority: null,
    source: "slack_dm",
    source_meta: {
      slack_user_id: event.user,
      slack_channel_id: event.channel,
      slack_message_ts: event.ts,
      original_text: text,
    },
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await applyTodoOps(userKey, [{ type: "add", todo }]);
  await ephemeralDm(event.user, `:white_check_mark: Added to your to-dos: "${text}"`);
}

async function handleReactionAdded(
  event: Extract<SlackEvent, { type: "reaction_added" }>
): Promise<void> {
  if (event.item.type !== "message") return;
  const settings = await loadSettings();
  const triggerEmoji =
    settings.personal_todos?.trigger_emoji ?? DEFAULT_TODO_TRIGGER_EMOJI;
  if (event.reaction !== triggerEmoji) return;

  const userKey = await resolveUserKeyForSlackId(event.user);
  if (!userKey) {
    await ephemeralDm(
      event.user,
      `I couldn't match your Slack ID (${event.user}) to a CSM in the dashboard. Ask an admin to map you at /settings/slack.`
    );
    return;
  }

  // Fetch the message text + permalink. Both calls go to Slack with the
  // bot token; the bot must be a member of the channel for
  // conversations.history to succeed on public/private channels. DMs
  // would require im:history (we'll skip those for v1 since reacting
  // to a DM is unusual).
  const messageText = await fetchMessageText(event.item.channel, event.item.ts);
  const permalink = await fetchPermalink(event.item.channel, event.item.ts);

  const title = (messageText ?? "(reacted Slack message)").slice(0, 200);
  const now = new Date().toISOString();
  const todo: PersonalTodo = {
    id: newTodoId(),
    title,
    details: null,
    due_date: null,
    surface_at: null,
    priority: null,
    source: "slack_reaction",
    source_meta: {
      slack_user_id: event.user,
      slack_channel_id: event.item.channel,
      slack_message_ts: event.item.ts,
      slack_permalink: permalink,
      original_text: messageText ?? undefined,
    },
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await applyTodoOps(userKey, [{ type: "add", todo }]);
  await ephemeralDm(
    event.user,
    permalink
      ? `:white_check_mark: Added that message to your to-dos: ${permalink}`
      : `:white_check_mark: Added that message to your to-dos.`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function resolveUserKeyForSlackId(
  slackUserId: string
): Promise<string | null> {
  if (!slackUserId) return null;
  const settings = await loadSettings();
  const customers = await loadCustomers();
  return userKeyFromSlackUserId(
    slackUserId,
    settings.slack.csm_user_ids,
    customers
  );
}

async function fetchMessageText(
  channel: string,
  ts: string
): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  // conversations.history with latest=ts + inclusive=true + limit=1
  // returns exactly that message. Works for public channels (needs
  // channels:history) and private channels (groups:history).
  const params = new URLSearchParams({
    channel,
    latest: ts,
    inclusive: "true",
    limit: "1",
  });
  try {
    const r = await fetch(
      `https://slack.com/api/conversations.history?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = (await r.json()) as {
      ok: boolean;
      messages?: Array<{ text?: string }>;
    };
    return j.ok ? (j.messages?.[0]?.text ?? null) : null;
  } catch {
    return null;
  }
}

async function fetchPermalink(
  channel: string,
  ts: string
): Promise<string | undefined> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return undefined;
  const params = new URLSearchParams({ channel, message_ts: ts });
  try {
    const r = await fetch(
      `https://slack.com/api/chat.getPermalink?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = (await r.json()) as { ok: boolean; permalink?: string };
    return j.ok ? j.permalink : undefined;
  } catch {
    return undefined;
  }
}

async function ephemeralDm(slackUserId: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: slackUserId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
  } catch {
    // Best-effort — if the ack DM fails, the todo still got created.
  }
}

function buildAddedAck(todo: PersonalTodo): string {
  const parts = [`:white_check_mark: Added to your to-dos: "${todo.title}"`];
  if (todo.surface_at) parts.push(`• Scheduled for ${todo.surface_at}`);
  if (todo.due_date) parts.push(`• Due ${todo.due_date}`);
  if (todo.priority)
    parts.push(`• Priority: ${todo.priority[0].toUpperCase()}${todo.priority.slice(1)}`);
  return parts.join("\n");
}

// GET returns a small, helpful status for the admin who's debugging
// the webhook URL. Doesn't leak any secrets.
export async function GET() {
  const signingSecretSet = Boolean(process.env.SLACK_SIGNING_SECRET);
  const botTokenSet = Boolean(process.env.SLACK_BOT_TOKEN);
  return NextResponse.json({
    ok: true,
    surface: "POST inbound only — Slack slash/events/reactions",
    SLACK_SIGNING_SECRET_set: signingSecretSet,
    SLACK_BOT_TOKEN_set: botTokenSet,
  });
}
