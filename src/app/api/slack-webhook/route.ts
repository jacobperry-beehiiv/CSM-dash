import { NextResponse } from "next/server";
import { loadCustomers } from "@/lib/data/load-customers";
import { loadSettings } from "@/lib/data/settings";
import { applyTodoOps } from "@/lib/personal-todos/store";
import { normalizeSlackText } from "@/lib/personal-todos/normalize-text";
import { resolveUserKeyForSlackId as resolveIdentity } from "@/lib/personal-todos/identity";
import {
  buildFindResultBlocks,
  buildRenewalCandidateBlocks,
  buildStripeResultBlocks,
  buildTodoCreateView,
  dispatchViewSubmission,
  FIND_CUSTOMER_SHORTCUT_CALLBACK_ID,
  FIND_SHARE_ACTION_ID,
  handleFindCustomerShortcut,
  handleFindShareAction,
  lookupSlashHandler,
  openSlackView,
  RENEWAL_CONFIRM_ACTION_ID,
  SLASH_HANDLERS,
  type RenewalConfirmActionValue,
  type ViewSubmissionPayload,
} from "@/lib/integrations/slack-views";
import { loadOverrides } from "@/lib/data/customer-overrides";
import { nextRenewalDate } from "@/lib/renewals/date";
import {
  buildRenewalKickoffMessage,
} from "@/lib/renewals/messages";
import {
  getRenewalThread,
  saveRenewalThreadIfAbsent,
  type RenewalThreadRecord,
} from "@/lib/data/renewal-threads";
import { appendActionLog } from "@/lib/data/customer-signals";
import {
  ASSIGN_OPEN_BUTTON_ACTION_ID,
  buildAssignButtonBlocks,
  openAssignModal,
} from "@/lib/integrations/slack-assign";
import { acquireDedupLock } from "@/lib/integrations/slack-dedup";
import {
  newTodoId,
  type PersonalTodo,
  type TodoSource,
} from "@/lib/personal-todos/types";
import {
  getBotUserId,
  parseAppMentionText,
  parseSlashTodoText,
  verifySlackSignature,
  type SlackEvent,
  type SlackEventEnvelope,
  type SlackSlashCommand,
  type UrlVerification,
} from "@/lib/integrations/slack-inbound";
import { DEFAULT_TODO_TRIGGER_EMOJI } from "@/lib/data/settings-types";
import { isCsmTeamMember } from "@/lib/auth/csm-team";

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

  // ── Drop Slack retries ────────────────────────────────────────────
  // Slack retries any inbound when our response misses the 3s budget,
  // up to 3 times. The assign flow (Drive folder create + template
  // copy + HubSpot PATCH + Slack thread post) reliably blows past 3s
  // for new accounts, which led to the same assignment running twice
  // and posting two near-identical thread replies. Our handlers are
  // NOT idempotent — re-running the assign duplicates to-dos and
  // re-posts. Ack the retry with 200 so Slack stops, and skip the
  // body. The original run is still in flight (or already done) and
  // owns the user-visible side effects.
  const retryNum = req.headers.get("x-slack-retry-num");
  if (retryNum) {
    console.warn("[slack-webhook] Slack retry — dropping", {
      retry_num: retryNum,
      retry_reason: req.headers.get("x-slack-retry-reason"),
    });
    return NextResponse.json({ ok: true, dropped: "retry" });
  }

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
        // Slack passes `thread_ts` only when the command is invoked
        // from within a thread reply input. Empty string is treated
        // the same as missing so we don't accidentally root at the
        // channel level.
        thread_ts: params.get("thread_ts") || undefined,
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
    in_thread: Boolean(slash.thread_ts),
    channel_id: slash.channel_id,
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
      threadTs: slash.thread_ts,
      channelId: slash.channel_id,
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

  if (payload.type === "block_actions") {
    return await handleBlockActions(payload);
  }

  if (payload.type === "message_action" || payload.type === "shortcut") {
    return await handleShortcut(payload);
  }

  // Other interactive types (view_closed, etc.) arrive here too. For
  // now we ACK and log — fill in handlers as we wire up new flows.
  console.log("[slack-webhook] Interactivity received — unhandled type", {
    type: payload.type,
  });
  return NextResponse.json({ ok: true });
}

interface ShortcutPayload {
  type: "message_action" | "shortcut";
  callback_id?: string;
  trigger_id?: string;
  user?: { id?: string };
  // message_action only:
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
}

/**
 * Routes Slack shortcut payloads (both "shortcut" — global, accessible
 * from the apps menu — and "message_action" — accessed from a
 * message's "..." menu, carries channel + thread context). Message
 * actions are what give us thread-aware search since custom slash
 * commands are blocked in threads at the workspace / app-config layer.
 */
async function handleShortcut(
  payload: { [key: string]: unknown } & { type?: string }
): Promise<NextResponse> {
  const typed = payload as ShortcutPayload;
  console.log("[slack-webhook] Shortcut received", {
    type: typed.type,
    callback_id: typed.callback_id,
    has_message_context: Boolean(typed.channel?.id),
  });
  if (
    typed.callback_id === FIND_CUSTOMER_SHORTCUT_CALLBACK_ID &&
    typed.trigger_id
  ) {
    // For thread context: prefer message.thread_ts (we're in a thread
    // reply), fall back to message.ts (top-level message — using ts
    // as thread_ts opens a NEW thread off that message, which is the
    // user's likely intent when clicking the shortcut on a channel
    // root message). For global shortcuts (no message context), both
    // are null and the result posts at channel root.
    const threadTs =
      typed.message?.thread_ts ?? typed.message?.ts ?? null;
    const channelId = typed.channel?.id ?? null;
    const result = await handleFindCustomerShortcut({
      triggerId: typed.trigger_id,
      channelId,
      threadTs,
    });
    if (!result.ok) {
      console.warn("[slack-webhook] find-customer shortcut open failed", {
        error: result.error,
      });
    }
    return NextResponse.json({ ok: true });
  }
  console.warn("[slack-webhook] Unhandled shortcut callback_id", {
    callback_id: typed.callback_id,
  });
  return NextResponse.json({ ok: true });
}

interface BlockActionsPayload {
  type: "block_actions";
  user?: { id?: string };
  response_url?: string;
  /** Required for views.open — Slack only mints a trigger_id on
   *  user-initiated interactions. We forward it straight through to
   *  the assign-modal opener. */
  trigger_id?: string;
  actions?: Array<{
    action_id?: string;
    value?: string;
  }>;
}

/**
 * block_actions dispatcher. Each interactive component (button,
 * static_select, etc.) routes by `action_id` to a handler. Today
 * there's just one — the "Share with channel" button on the /find
 * snapshot — but the registry shape is in place so the next button
 * (e.g. "Add this customer to my to-dos") is one match-case away.
 */
async function handleBlockActions(
  payload: { [key: string]: unknown } & { type?: string }
): Promise<NextResponse> {
  const typed = payload as BlockActionsPayload;
  const action = typed.actions?.[0];
  if (!action || !action.action_id) {
    console.warn("[slack-webhook] block_actions with no action_id", payload);
    return NextResponse.json({ ok: true });
  }
  console.log("[slack-webhook] block_actions received", {
    action_id: action.action_id,
    user_id: typed.user?.id,
  });

  if (action.action_id === ASSIGN_OPEN_BUTTON_ACTION_ID) {
    if (!typed.trigger_id) {
      console.warn("[slack-webhook] assign_open_modal click missing trigger_id");
      return NextResponse.json({ ok: true });
    }
    // Decode the thread context that buildAssignButtonBlocks stamped
    // into the button's `value`. Fall back to empty fields so the
    // modal still opens — the handler will degrade gracefully (no
    // thread reply, no Drive folder).
    let threadContext = {
      channel: "",
      thread_ts: "",
      requester_user: "",
    };
    try {
      threadContext = JSON.parse(action.value ?? "{}");
    } catch {
      console.warn(
        "[slack-webhook] assign_open_modal: couldn't parse button value",
        { raw: action.value }
      );
    }
    const result = await openAssignModal({
      triggerId: typed.trigger_id,
      threadContext,
    });
    if (!result.ok) {
      // Surface the failure in-thread so the user knows the button
      // didn't disappear into the void.
      if (threadContext.channel && threadContext.thread_ts) {
        await postThreadReply(threadContext.channel, threadContext.thread_ts, {
          text: `:warning: Couldn't open the Assign form: ${result.error ?? "unknown error"}.`,
        });
      }
      console.warn("[slack-webhook] openAssignModal failed", {
        error: result.error,
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (action.action_id === FIND_SHARE_ACTION_ID) {
    if (!typed.response_url) {
      console.warn("[slack-webhook] find_share without response_url");
      return NextResponse.json({ ok: true });
    }
    // Await the share work — Vercel's serverless runtime kills the
    // function as soon as the response returns, so a fire-and-forget
    // void promise gets cut off mid-execution (the 13ms duration on
    // the click attempt was the receipt — the actual share never
    // ran). The work is fast (~1s typical: load book + search +
    // post), well inside Slack's 3-second ACK window.
    const result = await handleFindShareAction({
      value: action.value ?? "",
      responseUrl: typed.response_url,
    });
    console.log("[slack-webhook] find_share completed", {
      ok: result.ok,
      error: result.error,
    });
    return NextResponse.json({ ok: true });
  }

  if (action.action_id === RENEWAL_CONFIRM_ACTION_ID) {
    let parsed: RenewalConfirmActionValue | null = null;
    try {
      parsed = JSON.parse(action.value ?? "{}") as RenewalConfirmActionValue;
    } catch {
      console.warn(
        "[slack-webhook] renewal_confirm: couldn't parse button value",
        { raw: action.value }
      );
    }
    if (!parsed?.workspace_id) {
      return NextResponse.json({ ok: true });
    }
    await handleRenewalConfirmAction({
      value: parsed,
      responseUrl: typed.response_url ?? null,
    });
    return NextResponse.json({ ok: true });
  }

  console.warn(
    "[slack-webhook] No handler registered for action_id",
    { action_id: action.action_id }
  );
  return NextResponse.json({ ok: true });
}

/**
 * Confirm-button click from the `@normbot renewal` candidate picker.
 * Loads the customer, posts (or re-links) the pricing thread in the
 * configured Renewals Slack channel, persists the ts to
 * `csm:renewal-threads:v1`, and replaces the ephemeral picker with a
 * "here's your thread" confirmation.
 *
 * Idempotent: if a thread already exists for the workspace (auto-
 * opened by the milestone engine at 90d, or opened by a teammate),
 * we skip the kickoff post and just report the existing thread link
 * so no duplicate kickoff message lands in the channel.
 */
async function handleRenewalConfirmAction(args: {
  value: RenewalConfirmActionValue;
  responseUrl: string | null;
}): Promise<void> {
  const { value, responseUrl } = args;
  try {
    const [customers, settings, overrides] = await Promise.all([
      loadCustomers(),
      loadSettings(),
      loadOverrides(),
    ]);
    const customer = customers.find(
      (c) => c.workspace_id === value.workspace_id
    );
    if (!customer) {
      await replaceEphemeral(responseUrl, {
        text:
          ":warning: I couldn't find that workspace in the customer book anymore. " +
          "Try `@normbot renewal <query>` again in a fresh thread — the book may have been re-synced since you saw the picker.",
      });
      return;
    }
    const channelId = settings.am?.renewals_slack_channel_id?.trim() ?? "";
    if (!channelId) {
      await replaceEphemeral(responseUrl, {
        text:
          ":warning: The Renewals Slack channel isn't configured yet. " +
          "Set it at `/settings/slack → Renewals Slack channel`, then run the command again.",
      });
      return;
    }
    const renewalIso = nextRenewalDate(customer);
    if (!renewalIso) {
      await replaceEphemeral(responseUrl, {
        text:
          `:warning: *${customer.company_name ?? customer.workspace_name ?? "This customer"}* doesn't have a next-renewal date on file (no next_invoice or renewal_date). ` +
          `Check the customer in the dashboard first — a valid renewal date is what the milestone engine's pings + pacing math run against.`,
      });
      return;
    }
    const stage =
      overrides[value.workspace_id]?.lifecycle_stage?.trim() || null;

    const existing = await getRenewalThread(value.workspace_id);
    if (existing) {
      await replaceEphemeral(responseUrl, {
        text:
          `:handshake: Pricing thread for *${customer.company_name ?? customer.workspace_name ?? "this customer"}* already exists — no duplicate kickoff posted.` +
          buildThreadPermalink(existing.channel_id, existing.thread_ts),
      });
      return;
    }

    const opener = `<@${value.requester_slack_id}>`;
    const kickoffText = buildRenewalKickoffMessage({
      customer,
      settings,
      renewalIso,
      lifecycleStage: stage,
      openedByLine: `_(opened by ${opener} via \`@normbot renewal\`)_`,
    });
    const posted = await postSlackMessage({
      channel: channelId,
      text: kickoffText,
    });
    if (!posted.ok || !posted.ts) {
      await replaceEphemeral(responseUrl, {
        text:
          `:warning: I couldn't post to the Renewals channel — Slack said \`${
            posted.error ?? "unknown"
          }\`. Confirm the bot user is a member of \`${channelId}\` and try again.`,
      });
      return;
    }
    const record: RenewalThreadRecord = {
      channel_id: channelId,
      thread_ts: posted.ts,
      opened_by:
        value.requester_slack_id ? `slack:${value.requester_slack_id}` : "manual",
      opened_at: new Date().toISOString(),
      origin: "manual",
      kickoff_context: {
        workspace_id: value.workspace_id,
        workspace_name: customer.workspace_name ?? undefined,
        lifecycle_stage: stage,
        renewal_date: renewalIso,
        arr: customer.arr ?? null,
      },
    };
    await saveRenewalThreadIfAbsent(value.workspace_id, record);

    // Audit trail on the customer's Notes timeline. Best-effort —
    // never blocks the ephemeral update.
    try {
      await appendActionLog([
        {
          workspace_id: value.workspace_id,
          text: "Renewal pricing thread opened",
          created_by: `slack:${value.requester_slack_id}`,
          action_kind: "renewal_thread_opened",
          metadata: {
            channel_id: channelId,
            thread_ts: posted.ts,
            renewal_date: renewalIso,
            lifecycle_stage: stage,
            source: "normbot_renewal",
          },
        },
      ]);
    } catch (e) {
      console.warn("[slack-webhook] renewal_confirm appendActionLog failed", {
        workspace_id: value.workspace_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    await replaceEphemeral(responseUrl, {
      text:
        `:handshake: Pricing thread opened for *${customer.company_name ?? customer.workspace_name ?? "this customer"}*.` +
        buildThreadPermalink(channelId, posted.ts),
    });
  } catch (e) {
    console.error("[slack-webhook] renewal_confirm handler threw", {
      workspace_id: value.workspace_id,
      error: e instanceof Error ? e.message : String(e),
    });
    await replaceEphemeral(responseUrl, {
      text:
        `:warning: Something went wrong opening the pricing thread — ${
          e instanceof Error ? e.message : "unknown error"
        }.`,
    });
  }
}

/**
 * Best-effort permalink for a channel + thread ts. Slack's archive
 * URLs collapse the dot from the ts, so `1723486800.001200` becomes
 * `p1723486800001200`. If the caller doesn't need a link (public
 * channel, workspace URL unknown), returns an empty string so the
 * template above stays clean.
 */
function buildThreadPermalink(channelId: string, ts: string): string {
  if (!channelId || !ts) return "";
  const workspace = (
    process.env.SLACK_WORKSPACE_URL ?? "https://slack.com"
  ).replace(/\/+$/, "");
  const numeric = ts.replace(/\./g, "");
  return `\n<${workspace}/archives/${channelId}/p${numeric}|Open thread ↗>`;
}

/**
 * Post a top-level message (no thread_ts) to a channel. Thin wrapper
 * around `chat.postMessage`; used by the renewal-confirm flow so we
 * can capture the returned `ts` and stash it in KV.
 */
async function postSlackMessage(args: {
  channel: string;
  text?: string;
  blocks?: Array<Record<string, unknown>>;
}): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN missing" };
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: args.channel,
        text: args.text,
        blocks: args.blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const j = (await res.json()) as {
      ok: boolean;
      error?: string;
      ts?: string;
    };
    if (!j.ok) return { ok: false, error: j.error ?? "chat.postMessage failed" };
    return { ok: true, ts: j.ts };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Replace an ephemeral message via the Slack-provided response_url.
 * Used by the renewal-confirm flow so the candidate picker gets
 * swapped for a "here's your thread" confirmation — clean UX, no
 * lingering buttons after the CSM commits. Silent no-op when the
 * button click didn't carry a response_url.
 */
async function replaceEphemeral(
  responseUrl: string | null,
  body: { text?: string; blocks?: Array<Record<string, unknown>> }
): Promise<void> {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: true,
        text: body.text,
        blocks: body.blocks,
      }),
    });
  } catch (e) {
    console.warn(
      "[slack-webhook] replaceEphemeral threw",
      e instanceof Error ? e.message : e
    );
  }
}

async function handleViewSubmission(
  payload: ViewSubmissionPayload
): Promise<NextResponse> {
  console.log("[slack-webhook] View submission received", {
    callback_id: payload.view.callback_id,
    user_id: payload.user.id,
    view_id: payload.view.id,
  });
  // Idempotency: same `view.id` → same modal opening → same submit.
  // Drops the second copy of a user double-submit or any Slack
  // retry/replay that didn't carry x-slack-retry-num. The first
  // submission still runs to completion; the second returns a clean
  // ACK with no side effects.
  const lock = await acquireDedupLock(`view-submission:${payload.view.id}`, {
    callback_id: payload.view.callback_id,
    user_id: payload.user.id,
  });
  if (!lock.acquired) {
    console.warn(
      "[slack-webhook] View submission already processed — dropping duplicate",
      {
        callback_id: payload.view.callback_id,
        view_id: payload.view.id,
        original_at: lock.first_seen_at,
        age_ms: lock.age_ms,
      }
    );
    // Close the modal silently — return an empty ack. Slack treats
    // an empty 200 as "submission accepted, modal closes."
    return NextResponse.json({});
  }
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
  if (event.type === "app_mention") {
    await handleAppMention(event);
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
  // Strip Slack's bracket-pipe artifacts (user/group mentions,
  // <url|label> links, &lt;/&gt; entities) so the todo title reads
  // as plain text instead of "<@U12345> can you check
  // <https://foo.com|this>". Normalize BEFORE the 500-char slice so
  // we don't accidentally truncate inside a token.
  const text = normalizeSlackText(event.text).trim().slice(0, 500);

  // ── Command-style DMs route to the same handlers as @-mentions ──
  // Slack's `app_mention` event doesn't fire in DMs (every message
  // in a DM is implicitly directed at the bot), so we duplicate the
  // command-router logic here. Users can either say "find acme" or
  // just paste a to-do title — the first word being a known command
  // disambiguates.
  const firstWordMatch = /^\s*(\S+)/.exec(text);
  const firstWord = firstWordMatch ? firstWordMatch[1].toLowerCase() : "";
  const rest = text.slice(firstWordMatch ? firstWordMatch[0].length : 0).trim();
  const isCommand =
    firstWord === "find" ||
    firstWord === "search" ||
    firstWord === "lookup" ||
    firstWord === "ent-search" ||
    firstWord === "stripe" ||
    firstWord === "help";
  if (isCommand) {
    console.log("[slack-webhook] DM command", {
      command: firstWord,
      args_preview: rest.slice(0, 80),
    });
    if (firstWord === "help") {
      await ephemeralDm(
        event.user,
        "I respond to these DM commands (same as `@bot` in a channel):\n" +
          "• `find <query>` — search customers + publications, results DM'd back\n" +
          "• `stripe <query>` — return a Stripe-dashboard link for the matching workspace\n" +
          "• `help` — this list\n" +
          "\nAnything else you DM me is captured as a personal to-do."
      );
      return;
    }

    const token = process.env.SLACK_BOT_TOKEN;
    // stripe — single-purpose link lookup. Same merged search as
    // `find` so `stripe newsletter-name` resolves to the parent
    // workspace's Stripe link.
    if (firstWord === "stripe") {
      if (!rest) {
        await ephemeralDm(
          event.user,
          "Add a search term — e.g. `stripe acme`. Returns the Stripe-dashboard URL for the matching customer."
        );
        return;
      }
      const blocks = await buildStripeResultBlocks(rest);
      if (!blocks) {
        await ephemeralDm(
          event.user,
          `No Stripe link found for "${rest}" — either no customer matches, or the matches have no Stripe customer ID on file.`
        );
        return;
      }
      if (token) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: event.channel,
            text: `Stripe link for "${rest}"`,
            blocks,
            unfurl_links: false,
            unfurl_media: false,
          }),
        });
      }
      return;
    }

    // find / search / lookup / ent-search
    if (!rest) {
      await ephemeralDm(
        event.user,
        "Add a search term — e.g. `find acme`. Matches against company name, workspace name, workspace ID, owner email, *and* publication names."
      );
      return;
    }
    const blocks = await buildFindResultBlocks(rest);
    if (!blocks) {
      await ephemeralDm(
        event.user,
        `No matches for "${rest}". Tried company name, workspace name, workspace ID, owner email, and publication name.`
      );
      return;
    }
    // chat.postMessage to the user's DM channel — same channel the
    // DM arrived on. Plain message (not ephemeral) since DMs are
    // already private to the bot + user pair.
    if (token) {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: event.channel,
          text: `Search results for "${rest}"`,
          blocks,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
    }
    return;
  }

  // ── Default: every other DM becomes a to-do ──
  const now = new Date().toISOString();
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
  // Master kill switch for the reaction → todo surface. Defaults
  // OFF after the bot-posted-message celebration-noise incident.
  // Flip back on from /settings/slack when needed.
  if (settings.personal_todos?.reactions_enabled !== true) {
    console.log(
      "[slack-webhook] Reaction → todo surface disabled in settings — ignored",
      { reactor: event.user, reaction: event.reaction }
    );
    return;
  }
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
  // Skip when the reacted-to message was posted by the bot itself
  // (to-do reminders, assignment summaries, etc.). Teammates use the
  // trigger reaction on those as a celebration emoji — "nice, you got
  // it done" — so adding it to the reactor's own to-do list and
  // DM'ing them an ack would be wrong.
  const botId = await getBotUserId();
  if (botId && event.item_user && event.item_user === botId) {
    console.log(
      "[slack-webhook] Reaction on bot-posted message — skipping (celebration, not save)",
      {
        reactor: event.user,
        item_user: event.item_user,
        channel: event.item.channel,
        ts: event.item.ts,
      }
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
    // Silent drop. Non-CSM-team Slack users have no userKey mapping
    // — sending them a "couldn't match your ID" DM creates noise for
    // people who weren't trying to use the bot in the first place
    // (they're reacting in a public channel where the bot lives, not
    // intending to onboard).
    console.warn("[slack-webhook] Reactor couldn't be resolved — silent drop", {
      slack_user_id: event.user,
      reason: resolved.reason,
    });
    return;
  }
  const userKey = resolved.userKey;
  // Gate on CSM-team membership. Slack reactions in shared channels
  // come from anyone the bot can see — engineers, AEs, support —
  // and we don't want every cross-team teammate to pick up a phantom
  // to-do + DM when they use the trigger emoji as a generic ack.
  const reactorEmail = userKeyFromEmailToEmail(userKey);
  if (!(await isCsmTeamMember(reactorEmail))) {
    console.log(
      "[slack-webhook] Reactor not on CSM team — skipping todo + DM",
      { slack_user_id: event.user, email: reactorEmail }
    );
    return;
  }

  // Fetch the message text + permalink. Both calls go to Slack with the
  // bot token; the bot must be a member of the channel for
  // conversations.replies to succeed on public/private channels. DMs
  // would require im:history (we'll skip those for v1 since reacting
  // to a DM is unusual).
  const messageText = await fetchMessageText(event.item.channel, event.item.ts);
  const permalink = await fetchPermalink(event.item.channel, event.item.ts);

  // Normalize Slack mrkdwn artifacts before title-slicing so the
  // resulting todo reads as plain prose. The full raw text still
  // lives in source_meta.original_text for traceability.
  const cleanedText = messageText ? normalizeSlackText(messageText) : null;
  const title = (cleanedText ?? "(reacted Slack message)").slice(0, 200);
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

/**
 * @-mention handler. Slack fires `app_mention` whenever someone tags
 * the bot in any channel/thread the bot is a member of. Unlike
 * custom slash commands (which Slack blocks in threads workspace-wide
 * here), app mentions work everywhere, so this is the most reliable
 * way to invoke bot commands from a thread.
 *
 * Supported commands (matched against the first word after the
 * mention, case-insensitive):
 *
 *   @bot find <query>   →  same search as /find, posts publicly in
 *                          the thread (everyone sees, since the
 *                          mention itself is public)
 *   @bot search …       →  alias
 *   @bot lookup …       →  alias
 *   @bot help           →  list available commands
 *
 * Posting reply pattern: chat.postMessage with `thread_ts` so the
 * reply lands in the thread. Public — @-mentions are public actions
 * and treating the reply as ephemeral feels wrong (the asker's
 * question is already visible).
 */
async function handleAppMention(
  event: Extract<SlackEvent, { type: "app_mention" }>
): Promise<void> {
  // Drop self-mentions (bot mentioning bot — shouldn't happen but
  // safe to guard).
  if (event.bot_id) {
    console.log("[slack-webhook] app_mention from another bot — ignored", {
      bot_id: event.bot_id,
    });
    return;
  }
  if (!event.user || !event.text) {
    console.warn("[slack-webhook] app_mention missing user or text", event);
    return;
  }
  const parsed = parseAppMentionText(event.text);
  console.log("[slack-webhook] App mention received", {
    user: event.user,
    channel: event.channel,
    in_thread: Boolean(event.thread_ts),
    command: parsed.command,
    args_preview: parsed.args.slice(0, 80),
  });

  const threadTs = event.thread_ts ?? event.ts;
  const channel = event.channel;

  // ── Help / no command ────────────────────────────────────────────
  if (!parsed.command || parsed.command === "help") {
    await postThreadReply(channel, threadTs, {
      text:
        "Hi! I respond to these @-mention commands:\n" +
        "• `@bot find <query>` — search customers + publications, post results in this thread\n" +
        "• `@bot stripe <query>` — return a Stripe-dashboard link for the matching workspace(s)\n" +
        "• `@bot renewal <query>` — pick an account and open its pricing thread in the Renewals channel\n" +
        "• `@bot assign` — open the new-account form (HubSpot owner + to-do + Drive folder)\n" +
        "• `@bot help` — show this list",
    });
    return;
  }

  // ── Find / search / lookup ───────────────────────────────────────
  if (
    parsed.command === "find" ||
    parsed.command === "search" ||
    parsed.command === "lookup" ||
    parsed.command === "ent-search"
  ) {
    if (!parsed.args.trim()) {
      await postThreadReply(channel, threadTs, {
        text:
          "Add a search term — e.g. `@bot find acme`. " +
          "Matches against company name, workspace name, workspace ID, owner email, *and* publication names.",
      });
      return;
    }
    const query = parsed.args.trim();
    const blocks = await buildFindResultBlocks(query);
    if (!blocks) {
      await postThreadReply(channel, threadTs, {
        text: `No matches for "${query}". Tried company name, workspace name, workspace ID, owner email, and publication name.`,
      });
      return;
    }
    await postThreadReply(channel, threadTs, {
      text: `Search results for "${query}"`,
      blocks,
    });
    return;
  }

  // ── Stripe link lookup ────────────────────────────────────────────
  if (parsed.command === "stripe") {
    if (!parsed.args.trim()) {
      await postThreadReply(channel, threadTs, {
        text:
          "Add a search term — e.g. `@bot stripe acme`. " +
          "Returns the Stripe-dashboard URL for the matching customer.",
      });
      return;
    }
    const query = parsed.args.trim();
    const blocks = await buildStripeResultBlocks(query);
    if (!blocks) {
      await postThreadReply(channel, threadTs, {
        text: `No Stripe link found for "${query}" — either no customer matches, or the matches have no Stripe customer ID on file.`,
      });
      return;
    }
    await postThreadReply(channel, threadTs, {
      text: `Stripe link for "${query}"`,
      blocks,
    });
    return;
  }

  // ── Assign (new-account onboarding) ──────────────────────────────
  // @bot assign in any thread → post a button reply that opens the
  // assign modal. We can't open the modal directly from app_mention
  // because Slack only hands out trigger_ids on user-initiated
  // interactions (slash commands or block actions) — the button click
  // gives us one.
  if (parsed.command === "assign") {
    const resolved = await resolveUserKeyForSlackId(event.user);
    // userKey isn't strictly required to surface the button, but the
    // requester's email DOES need to make it into the modal so we can
    // (a) find their Google tokens for Drive folder creation and (b)
    // stamp it on the customer-overrides write. Encode it now while
    // we have it; the button's `value` field round-trips it back on
    // click.
    const requesterEmail = resolved.userKey
      ? userKeyFromEmailToEmail(resolved.userKey)
      : "";
    await postThreadReply(channel, threadTs, {
      text: "Open the Assign form to onboard a new account.",
      blocks: buildAssignButtonBlocks({
        channel,
        thread_ts: threadTs,
        requester_user: requesterEmail,
      }),
    });
    return;
  }

  // ── Renewal (kickoff a pricing thread for a customer) ────────────
  // `@bot renewal <query>` fuzzy-searches the book, posts an
  // ephemeral candidate list to the requester, and on Confirm opens
  // (or re-links) the pricing thread in the configured Renewals
  // channel. Handled together with the 90d milestone auto-open —
  // both persist the thread ts to csm:renewal-threads:v1 so later
  // milestone pings + the Renewal Confirmed lifecycle reply land in
  // the same thread.
  if (parsed.command === "renewal") {
    if (!parsed.args.trim()) {
      await postThreadReply(channel, threadTs, {
        text:
          "Add an account name — e.g. `@bot renewal acme`. " +
          "I'll show up to 5 candidates and you pick which one to open the pricing thread for.",
      });
      return;
    }
    const query = parsed.args.trim();
    const overrides = await loadOverrides();
    const lifecycleStageFor = (c: import("@/lib/types").Customer) =>
      c.workspace_id
        ? overrides[c.workspace_id]?.lifecycle_stage?.trim() || null
        : null;
    const blocks = await buildRenewalCandidateBlocks({
      query,
      requesterSlackId: event.user,
      originChannel: channel,
      originThreadTs: threadTs,
      renewalDateFor: nextRenewalDate,
      lifecycleStageFor,
    });
    if (!blocks) {
      await postSlackEphemeral({
        channel,
        user: event.user,
        text: `No accounts match "${query}" — try the company name, workspace name, workspace ID, or owner email.`,
      });
      return;
    }
    const posted = await postSlackEphemeral({
      channel,
      user: event.user,
      text: `Renewal candidates for "${query}"`,
      blocks,
    });
    if (!posted.ok) {
      // Ephemeral requires channel membership. Fall back to a public
      // thread reply so the CSM at least sees something (they can
      // pick from the same list; the buttons still work).
      console.warn(
        "[slack-webhook] postSlackEphemeral for renewal fell back to thread",
        { channel, error: posted.error }
      );
      await postThreadReply(channel, threadTs, {
        text: `Renewal candidates for "${query}"`,
        blocks,
      });
    }
    return;
  }

  // Unknown command — friendly hint.
  await postThreadReply(channel, threadTs, {
    text:
      `I don't recognize \`${parsed.command}\`. Try \`@bot help\` for the list of commands I support.`,
  });
}

/** userKey shape used by personal-todos is `email:<lowercased>`; the
 *  Slack-assign flow wants the raw email back out to look up Google
 *  tokens. Strip the prefix if present; pass through otherwise so
 *  shape changes in identity.ts don't silently break this path. */
function userKeyFromEmailToEmail(userKey: string): string {
  if (userKey.startsWith("email:")) return userKey.slice("email:".length);
  return userKey;
}

/** Post a public reply into a thread. Used by handleAppMention so the
 *  whole thread can see the response, since the @-mention itself is
 *  public. */
async function postThreadReply(
  channel: string,
  threadTs: string,
  body: { text?: string; blocks?: Array<Record<string, unknown>> }
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        thread_ts: threadTs,
        text: body.text,
        blocks: body.blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const j = (await res.json()) as { ok: boolean; error?: string };
    if (!j.ok) {
      console.warn("[slack-webhook] postThreadReply failed", {
        error: j.error,
        channel,
      });
    }
  } catch (e) {
    console.warn(
      "[slack-webhook] postThreadReply threw",
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Post an ephemeral (only-visible-to-`user`) message into `channel`.
 * Used by `@bot renewal <query>` so the candidate picker doesn't
 * clutter the origin channel. Returns { ok, error } instead of void
 * so the caller can fall back to a public thread reply on failure
 * (e.g. bot not in the channel, invalid user id, chat:write.customize
 * scope missing).
 *
 * Slack's chat.postEphemeral will fail with `not_in_channel` if the
 * bot isn't a member — which is common on quick manual tests in
 * private channels. The renewal command's fallback keeps the CSM
 * unblocked in that case.
 */
async function postSlackEphemeral(args: {
  channel: string;
  user: string;
  text?: string;
  blocks?: Array<Record<string, unknown>>;
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN missing" };
  try {
    const res = await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: args.channel,
        user: args.user,
        text: args.text,
        blocks: args.blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const j = (await res.json()) as { ok: boolean; error?: string };
    if (!j.ok) {
      return { ok: false, error: j.error ?? "chat.postEphemeral failed" };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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
  // Use conversations.replies, not conversations.history.
  //
  // conversations.history returns ONLY top-level channel messages —
  // threaded replies don't appear there. When the reacted message is
  // a thread reply, passing its ts as `latest` to history resolves to
  // the nearest top-level message at or before that timestamp, which
  // is the wrong message entirely (the symptom: "reacted on a thread
  // reply, but the to-do picks up the most recent channel message").
  //
  // conversations.replies handles all three cases we care about:
  //   • Standalone non-threaded message → returns just that message.
  //   • Thread parent → returns parent + all replies.
  //   • Thread reply → returns the parent + all siblings (including
  //     the reacted message).
  // We scan the returned `messages` array for the exact ts to find
  // the one the user actually reacted to.
  //
  // limit=200 is enough headroom for the vast majority of threads.
  // Reactions on the 201st+ reply of an extremely long thread would
  // miss; not worth paginating for v1.
  const params = new URLSearchParams({
    channel,
    ts,
    inclusive: "true",
    limit: "200",
  });
  try {
    const r = await fetch(
      `https://slack.com/api/conversations.replies?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = (await r.json()) as {
      ok: boolean;
      messages?: Array<{ ts?: string; text?: string }>;
    };
    if (!j.ok) return null;
    const match = j.messages?.find((m) => m.ts === ts);
    return match?.text ?? null;
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
// the webhook URL. Doesn't leak any secrets. Includes the list of
// slash commands the registry recognizes so admins can verify the
// expected build is live without trying a command.
export async function GET() {
  const signingSecretSet = Boolean(process.env.SLACK_SIGNING_SECRET);
  const botTokenSet = Boolean(process.env.SLACK_BOT_TOKEN);
  return NextResponse.json({
    ok: true,
    surface: "POST inbound only — Slack slash/events/reactions",
    SLACK_SIGNING_SECRET_set: signingSecretSet,
    SLACK_BOT_TOKEN_set: botTokenSet,
    registered_slash_commands: Object.keys(SLASH_HANDLERS).sort(),
    todo_fallback:
      "Any slash command name containing 'todo' (case-insensitive) and not in the registry falls through to the to-do flow.",
  });
}
