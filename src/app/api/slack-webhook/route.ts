import { NextResponse } from "next/server";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadSettings } from "@/lib/data/settings";
import { applyTodoOps } from "@/lib/personal-todos/store";
import { resolveUserKeyForSlackId as resolveIdentity } from "@/lib/personal-todos/identity";
import {
  buildTodoCreateView,
  dispatchViewSubmission,
  lookupSlashHandler,
  openSlackView,
  type ViewSubmissionPayload,
} from "@/lib/integrations/slack-views";
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
  // Read the body ONCE as raw text — verification needs the exact bytes
  // Slack signed over, so we can't rely on req.json() further down.
  const rawBody = await req.text();
  const contentType = req.headers.get("content-type") ?? "";

  // ── URL verification handshake — short-circuit BEFORE auth ────────
  // Slack POSTs `{type: "url_verification", challenge: "..."}` when an
  // admin first configures the Event Subscriptions request URL. We
  // intentionally let this through without requiring SLACK_SIGNING_SECRET
  // because (a) the response has no side effects, just echoes the
  // challenge, and (b) the env-var-not-set case breaks the bootstrap
  // flow ("can't add the URL until the secret is set, but the redeploy
  // to pick up the secret hasn't happened yet"). Once the URL is
  // verified, every subsequent inbound goes through the verification
  // below.
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody) as Partial<UrlVerification>;
      if (
        parsed &&
        parsed.type === "url_verification" &&
        typeof parsed.challenge === "string"
      ) {
        return NextResponse.json({ challenge: parsed.challenge });
      }
    } catch {
      // Not JSON or malformed — fall through to the verified paths.
    }
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn(
      "[slack-webhook] SLACK_SIGNING_SECRET not set — rejecting non-handshake request"
    );
    return NextResponse.json(
      {
        error:
          "SLACK_SIGNING_SECRET not configured. Set it in Vercel env vars (copy from Slack app → Basic Information → Signing Secret) so inbound webhooks can be verified.",
      },
      { status: 503 }
    );
  }

  const verified = verifySlackSignature({
    rawBody,
    signatureHeader: req.headers.get("x-slack-signature"),
    timestampHeader: req.headers.get("x-slack-request-timestamp"),
    signingSecret,
  });
  if (!verified) {
    console.warn(
      "[slack-webhook] Signature verification failed",
      {
        hasSigHeader: Boolean(req.headers.get("x-slack-signature")),
        hasTsHeader: Boolean(req.headers.get("x-slack-request-timestamp")),
        contentType,
        bodyLen: rawBody.length,
      }
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (contentType.includes("application/json")) {
      const parsed = JSON.parse(rawBody) as
        | UrlVerification
        | SlackEventEnvelope;
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
      // Interactivity payloads (modal submissions, button clicks) come
      // form-urlencoded with a single `payload` field carrying JSON.
      // We branch on that BEFORE the slash-command branch so we don't
      // try to read `command=` off an interactive payload (which has
      // none).
      const payloadRaw = params.get("payload");
      if (payloadRaw) {
        return await handleInteractivity(payloadRaw);
      }
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
  console.log("[slack-webhook] Slash command received", {
    command: slash.command,
    text_preview: slash.text.slice(0, 80),
    user_id: slash.user_id,
    user_name: slash.user_name,
  });
  // We intentionally accept any slash command name. The endpoint is
  // signature-verified and dedicated to this app — anything landing
  // here is by definition ours, so being strict about the name just
  // burns flexibility (admins can register `/todo`, `/csm-todo`,
  // `/dash-todo`, etc. and they all create personal to-dos). The log
  // line above records the actual name so it's easy to spot if someone
  // ever points an unrelated slash command at this URL by mistake.
  const resolved = await resolveUserKeyForSlackId(slash.user_id);
  if (!resolved.userKey) {
    console.warn(
      "[slack-webhook] Slash invoker couldn't be resolved",
      {
        slack_user_id: slash.user_id,
        slack_user_name: slash.user_name,
        reason: resolved.reason,
      }
    );
    return NextResponse.json({
      response_type: "ephemeral",
      text: `Couldn't match your Slack ID (${slash.user_id}) — ${
        resolved.reason ?? "no mapping found"
      }. Ask Jacob to look at /settings/slack → CSM Slack IDs.`,
    });
  }
  const userKey = resolved.userKey;
  console.log("[slack-webhook] Slash invoker resolved", {
    slack_user_id: slash.user_id,
    via: resolved.via,
    userKey,
  });

  // Slash command registry — multiple commands can target this
  // endpoint and each can have its own flow.
  const slashHandler = lookupSlashHandler(slash.command);
  if (slashHandler) {
    const result = await slashHandler({
      triggerId: slash.trigger_id,
      inlineText: slash.text,
      userKey,
      slackUserId: slash.user_id,
    });
    // null → modal opened, no ack message needed (Slack just sees 200).
    if (result === null) {
      return new NextResponse(null, { status: 200 });
    }
    return NextResponse.json(result);
  }

  // No registry hit. We *used* to silently fall through to the to-do
  // flow for any unknown command (so admins could register /todo
  // under any name and it just worked), but that swallows commands
  // that DIDN'T deploy yet — e.g. /find acme would land as a to-do
  // titled "acme". Guard the fallback: only treat unrecognized
  // commands as the to-do flow when the command name itself
  // contains "todo" (case-insensitive). Otherwise return a clear
  // error so the user knows the command isn't wired up.
  const normalizedCommand = slash.command.replace(/^\//, "").toLowerCase();
  if (!normalizedCommand.includes("todo")) {
    console.warn(
      "[slack-webhook] Slash command not in registry and not todo-shaped",
      { command: slash.command }
    );
    return NextResponse.json({
      response_type: "ephemeral",
      text:
        `Slash command \`${slash.command}\` isn't wired up yet. ` +
        `If you just deployed it, wait for Vercel to finish building (~1-2 min) and try again. ` +
        `Otherwise, register it in the Slack app config and add a handler in slack-views.ts.`,
    });
  }

  const parsed = parseSlashTodoText(slash.text);
  if (!parsed.title) {
    // No inline text → open the guided modal. Two flows now:
    //   /todo            → modal pops with empty fields
    //   /todo Title here → inline-parses, no modal (fast path)
    // The modal's submission lands back at this webhook as a
    // view_submission interactive payload and is routed to
    // `todoCreateHandler` by callback_id.
    if (!slash.trigger_id) {
      console.warn(
        "[slack-webhook] Slash invocation with empty text and no trigger_id — can't open modal",
        { user_id: slash.user_id }
      );
      return NextResponse.json({
        response_type: "ephemeral",
        text: "Slack didn't send a trigger_id so I can't open the form. Try `/todo Title here` to add inline.",
      });
    }
    console.log(
      "[slack-webhook] Slash had no inline text — opening modal",
      { user_id: slash.user_id }
    );
    const opened = await openSlackView(slash.trigger_id, buildTodoCreateView());
    if (!opened.ok) {
      return NextResponse.json({
        response_type: "ephemeral",
        text:
          "Couldn't open the form: " +
          (opened.error ?? "unknown error") +
          ". Try `/todo Title here` to add inline.",
      });
    }
    // ACK with an empty 200 — the modal is already open, no message needed.
    return new NextResponse(null, { status: 200 });
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
    // null parser value → default to true (reminders ON). `false`
    // means the user added `!silent` / `!quiet`.
    remind_via_slack: parsed.remind_via_slack !== false,
    created_at: now,
    updated_at: now,
  };
  await applyTodoOps(userKey, [{ type: "add", todo }]);
  console.log("[slack-webhook] Slash → todo created", {
    userKey,
    todoId: todo.id,
    title: todo.title.slice(0, 80),
    surface_at: todo.surface_at,
    due_date: todo.due_date,
    priority: todo.priority,
  });
  return NextResponse.json({
    response_type: "ephemeral",
    text: buildAddedAck(todo),
  });
}

// ─── Interactivity (modal submissions, button clicks) ───────────────
//
// Slack POSTs all interactive payloads (view_submission, block_actions,
// shortcut, etc.) as `application/x-www-form-urlencoded` with a single
// `payload` field containing JSON. Different request URL setting in
// Slack ("Interactivity & Shortcuts" → Request URL) but identical
// transport otherwise — we use the same webhook for both.
//
// Submission flow:
//   1. User runs `/todo` → handleSlashCommand opens a modal via
//      views.open with callback_id = "todo_create".
//   2. User fills + submits → Slack POSTs view_submission here.
//   3. We resolve user identity, dispatch by callback_id to a
//      handler in lib/integrations/slack-views.ts, return Slack's
//      expected response_action JSON.
//
// Other interactive types (block_actions, shortcut, etc.) are routed
// the same way as we add support — extend handleInteractivity.

async function handleInteractivity(payloadRaw: string): Promise<NextResponse> {
  let payload: { type?: string } & Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (e) {
    console.warn("[slack-webhook] Couldn't parse interactivity payload", e);
    return NextResponse.json({ ok: true });
  }

  if (payload.type === "view_submission") {
    return await handleViewSubmission(payload as unknown as ViewSubmissionPayload);
  }

  // Other interactive types (block_actions, shortcut, view_closed)
  // arrive here too. For now we ACK and log — fill in handlers as we
  // wire up new flows.
  console.log("[slack-webhook] Interactivity received — unhandled type", {
    type: payload.type,
  });
  return NextResponse.json({ ok: true });
}

async function handleViewSubmission(
  payload: ViewSubmissionPayload
): Promise<NextResponse> {
  console.log("[slack-webhook] View submission received", {
    callback_id: payload.view.callback_id,
    user_id: payload.user.id,
  });
  const resolved = await resolveUserKeyForSlackId(payload.user.id);
  if (!resolved.userKey) {
    console.warn(
      "[slack-webhook] View submitter couldn't be resolved",
      { slack_user_id: payload.user.id, reason: resolved.reason }
    );
    // Block-level error on the first input block so Slack re-renders
    // the modal with a clear message instead of silently dismissing.
    return NextResponse.json({
      response_action: "errors",
      errors: {
        title:
          "Couldn't match your Slack ID — " +
          (resolved.reason ?? "no mapping") +
          ". Ask Jacob to add you at /settings/slack → CSM Slack IDs.",
      },
    });
  }
  const result = await dispatchViewSubmission(payload, resolved.userKey);
  // Strip our private `_ack_message` field before forwarding to Slack,
  // and DM it to the submitter so the modal-disappears-into-the-void
  // case still has a permanent confirmation in their DM history. Each
  // handler composes its own success copy.
  const { _ack_message, ...slackResponse } = result;
  if (!result.response_action && _ack_message) {
    await ephemeralDm(payload.user.id, String(_ack_message));
  }
  return NextResponse.json(slackResponse);
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
  // Subscribed but unhandled — make it visible so unexpected types
  // don't disappear into the void.
  console.warn(
    "[slack-webhook] Received unhandled event type",
    // @ts-expect-error narrow type lookup is fine at runtime
    event?.type ?? "(missing)"
  );
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

  const resolved = await resolveUserKeyForSlackId(event.user);
  if (!resolved.userKey) {
    console.warn("[slack-webhook] DM sender couldn't be resolved", {
      slack_user_id: event.user,
      reason: resolved.reason,
    });
    await ephemeralDm(
      event.user,
      `I couldn't match your Slack ID (${event.user}) — ${
        resolved.reason ?? "no mapping found"
      }. Ask Jacob to look at /settings/slack → CSM Slack IDs.`
    );
    return;
  }
  const userKey = resolved.userKey;
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
  if (event.item.type !== "message") {
    console.warn(
      "[slack-webhook] reaction_added on non-message item — ignored",
      { itemType: event.item.type, reactor: event.user }
    );
    return;
  }
  const settings = await loadSettings();
  const triggerEmoji =
    settings.personal_todos?.trigger_emoji ?? DEFAULT_TODO_TRIGGER_EMOJI;
  if (event.reaction !== triggerEmoji) {
    // The single most common silent-no-op reason: the configured trigger
    // emoji doesn't match what the user reacted with. Log both sides so
    // an admin can copy the actual reaction name into /settings/slack.
    console.warn(
      "[slack-webhook] reaction didn't match trigger emoji — ignored",
      { configured: triggerEmoji, received: event.reaction, reactor: event.user }
    );
    return;
  }
  console.log(
    "[slack-webhook] Trigger reaction matched, processing",
    {
      reaction: event.reaction,
      reactor: event.user,
      channel: event.item.channel,
      ts: event.item.ts,
    }
  );

  const resolved = await resolveUserKeyForSlackId(event.user);
  if (!resolved.userKey) {
    console.warn("[slack-webhook] Reactor couldn't be resolved", {
      slack_user_id: event.user,
      reason: resolved.reason,
    });
    await ephemeralDm(
      event.user,
      `I couldn't match your Slack ID (${event.user}) — ${
        resolved.reason ?? "no mapping found"
      }. Ask Jacob to look at /settings/slack → CSM Slack IDs.`
    );
    return;
  }
  const userKey = resolved.userKey;

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
  console.log("[slack-webhook] Reaction → todo created", {
    userKey,
    todoId: todo.id,
    title: todo.title.slice(0, 60),
  });
  await ephemeralDm(
    event.user,
    permalink
      ? `:white_check_mark: Added that message to your to-dos: ${permalink}`
      : `:white_check_mark: Added that message to your to-dos.`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Wrapper around `resolveIdentity` from lib/personal-todos/identity.ts
 *  that loads the settings + customer book on demand. Returns the rich
 *  ResolveResult so the caller can include the failure reason in the
 *  bounce DM (much more useful than a generic "couldn't match"). */
async function resolveUserKeyForSlackId(slackUserId: string) {
  if (!slackUserId) {
    return { userKey: null, via: null, reason: "no slack user id" } as const;
  }
  const settings = await loadSettings();
  const customers = await loadCustomers();
  return resolveIdentity(slackUserId, settings.slack.csm_user_ids, customers);
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
