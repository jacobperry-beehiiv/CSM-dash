/**
 * Slack Block Kit views — modal builders + a dispatch table keyed by
 * `callback_id`. Designed as a generic framework so adding new
 * interactive flows is two files:
 *
 *   1. A new builder here (function returning the view JSON).
 *   2. A new handler entry in the dispatch table that knows what to
 *      do with the submitted values.
 *
 * Why a registry instead of inline handling: today there's just the
 * to-do creation flow, but Jacob wants this to scale to other guided
 * Slack flows (logging risk signals, capturing meeting notes, etc.).
 * Forcing every new flow through the same shape keeps the surface
 * area predictable and the webhook router thin.
 *
 * View payload shape reference:
 *   https://api.slack.com/reference/block-kit/views
 */

import {
  newTodoId,
  type PersonalTodo,
  type TodoPriority,
} from "../personal-todos/types";
import { applyTodoOps } from "../personal-todos/store";
import {
  listHubspotOwners,
  patchHubspotCompanyProperties,
  type HubspotOwner,
} from "./hubspot";
import { loadCustomers } from "../data/load-customers";
import { masqueradeUrl, stripeCustomerUrl } from "../links";
import { DB, runNativeQuery } from "../metabase";
import type { Customer } from "../types";
import {
  ASSIGN_MODAL_CALLBACK_ID,
  assignModalHandler,
} from "./slack-assign";

// ─── Generic view-submission contract ─────────────────────────────────

/** What Slack sends on `view_submission`. We only type the fields we
 *  read; Slack sends more (team, hash, root_view_id) that we ignore. */
export interface ViewSubmissionPayload {
  type: "view_submission";
  user: { id: string; username?: string };
  view: {
    id: string;
    callback_id: string;
    state: {
      /** Keyed by our `block_id`, then by `action_id`. */
      values: Record<string, Record<string, ViewStateValue>>;
    };
    private_metadata?: string;
  };
  trigger_id?: string;
}

/** Discriminated union of the Block Kit input value shapes we use. */
export type ViewStateValue =
  | { type: "plain_text_input"; value: string | null }
  | { type: "datepicker"; selected_date: string | null }
  | {
      type: "static_select";
      selected_option: { value: string; text: { text: string } } | null;
    };

/** A submit handler returns either:
 *    - `{}` → close the modal silently
 *    - `{ response_action: "errors", errors: { block_id: msg } }` →
 *      keep modal open and surface field-level errors
 *    - `{ response_action: "clear" }` → close + clear all modals
 *  See https://api.slack.com/surfaces/modals#updating_response */
export interface ViewSubmitResponse {
  response_action?: "errors" | "clear" | "push" | "update";
  errors?: Record<string, string>;
  /** Optional ephemeral DM to send to the submitter after the modal
   *  closes. The route reads this then strips it before forwarding
   *  the rest to Slack — modal-disappears-without-feedback feels
   *  broken, so every successful submission should set this. */
  _ack_message?: string;
  // Allow extra fields for future expansion (push / update view JSON).
  [key: string]: unknown;
}

export type ViewSubmitHandler = (args: {
  payload: ViewSubmissionPayload;
  userKey: string;
}) => Promise<ViewSubmitResponse>;

// ─── Value extractors ────────────────────────────────────────────────

/** Pull a single field's value from the view state. Returns null when
 *  the block didn't render or the user left it blank. Convenience so
 *  handlers don't repeat the same `?.value ?? null` chain everywhere. */
export function getTextValue(
  payload: ViewSubmissionPayload,
  blockId: string,
  actionId = "value"
): string | null {
  const v = payload.view.state.values?.[blockId]?.[actionId];
  if (!v || v.type !== "plain_text_input") return null;
  const trimmed = (v.value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getDateValue(
  payload: ViewSubmissionPayload,
  blockId: string,
  actionId = "value"
): string | null {
  const v = payload.view.state.values?.[blockId]?.[actionId];
  if (!v || v.type !== "datepicker") return null;
  return v.selected_date ?? null;
}

export function getSelectValue(
  payload: ViewSubmissionPayload,
  blockId: string,
  actionId = "value"
): string | null {
  const v = payload.view.state.values?.[blockId]?.[actionId];
  if (!v || v.type !== "static_select") return null;
  return v.selected_option?.value ?? null;
}

// ─── To-do creation modal ────────────────────────────────────────────

export const TODO_CREATE_CALLBACK_ID = "todo_create";

/** Build the Block Kit JSON for the "New to-do" modal. Pure — accepts
 *  optional pre-fills so future flows (e.g. "edit existing todo") can
 *  reuse this layout with values populated. */
export function buildTodoCreateView(prefill?: {
  title?: string;
  details?: string;
  due_date?: string;
  surface_at?: string;
  priority?: TodoPriority;
}): Record<string, unknown> {
  const initialOption = prefill?.priority
    ? {
        text: {
          type: "plain_text",
          text:
            prefill.priority[0].toUpperCase() + prefill.priority.slice(1),
        },
        value: prefill.priority,
      }
    : undefined;
  return {
    type: "modal",
    callback_id: TODO_CREATE_CALLBACK_ID,
    title: { type: "plain_text", text: "New to-do" },
    submit: { type: "plain_text", text: "Add" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "title",
        label: { type: "plain_text", text: "Title" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "What needs doing?",
          },
          ...(prefill?.title ? { initial_value: prefill.title } : {}),
        },
      },
      {
        type: "input",
        block_id: "details",
        optional: true,
        label: { type: "plain_text", text: "Details" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Notes, links, context (optional)",
          },
          ...(prefill?.details ? { initial_value: prefill.details } : {}),
        },
      },
      {
        type: "input",
        block_id: "due_date",
        optional: true,
        label: { type: "plain_text", text: "Due date" },
        element: {
          type: "datepicker",
          action_id: "value",
          ...(prefill?.due_date
            ? { initial_date: prefill.due_date }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "surface_at",
        optional: true,
        label: {
          type: "plain_text",
          text: "Surface on (hide until this date)",
        },
        element: {
          type: "datepicker",
          action_id: "value",
          ...(prefill?.surface_at
            ? { initial_date: prefill.surface_at }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "priority",
        optional: true,
        label: { type: "plain_text", text: "Priority" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "No priority",
          },
          options: [
            {
              text: { type: "plain_text", text: "High" },
              value: "high",
            },
            {
              text: { type: "plain_text", text: "Medium" },
              value: "medium",
            },
            {
              text: { type: "plain_text", text: "Low" },
              value: "low",
            },
          ],
          ...(initialOption ? { initial_option: initialOption } : {}),
        },
      },
      {
        type: "input",
        block_id: "remind_via_slack",
        optional: true,
        label: { type: "plain_text", text: "Slack reminders" },
        element: {
          type: "checkboxes",
          action_id: "value",
          // Default: checked. Slack's `initial_options` makes the
          // checkbox start ON. If the user unchecks before submit, the
          // submission state will have `selected_options: []` and we
          // interpret that as opt-out.
          initial_options: [
            {
              text: {
                type: "plain_text",
                text: "Ping me on Slack at the deadline ladder (3 days out, 1 day out, due today, 3 days overdue)",
              },
              value: "yes",
            },
          ],
          options: [
            {
              text: {
                type: "plain_text",
                text: "Ping me on Slack at the deadline ladder (3 days out, 1 day out, due today, 3 days overdue)",
              },
              value: "yes",
            },
          ],
        },
      },
    ],
  };
}

/** Extract the remind-via-Slack checkbox from a view-submission. The
 *  Block Kit `checkboxes` element shape is different from inputs/
 *  selects — `selected_options` is an array; non-empty means checked. */
function getRemindViaSlackValue(payload: ViewSubmissionPayload): boolean {
  const v = payload.view.state.values?.["remind_via_slack"]?.["value"];
  if (!v) return true; // field not rendered → default ON
  // Type guard for the checkboxes shape (not in our ViewStateValue
  // union since we only modeled the three we used initially).
  const selected = (
    v as { type?: string; selected_options?: Array<{ value: string }> }
  ).selected_options;
  if (!Array.isArray(selected)) return true;
  return selected.length > 0;
}

/** Submission handler for the to-do create modal. Reads values out of
 *  the view state, creates the to-do for `userKey`, returns errors
 *  back to Slack if the title is empty (Slack will re-render the
 *  modal with the error inline). */
export const todoCreateHandler: ViewSubmitHandler = async ({
  payload,
  userKey,
}) => {
  const title = getTextValue(payload, "title");
  if (!title) {
    return {
      response_action: "errors",
      errors: { title: "Add a title before submitting." },
    };
  }
  const details = getTextValue(payload, "details");
  const due_date = getDateValue(payload, "due_date");
  const surface_at = getDateValue(payload, "surface_at");
  const prioritySel = getSelectValue(payload, "priority");
  const priority: TodoPriority | null =
    prioritySel === "high" ||
    prioritySel === "medium" ||
    prioritySel === "low"
      ? prioritySel
      : null;

  const remind_via_slack = getRemindViaSlackValue(payload);
  const now = new Date().toISOString();
  const todo: PersonalTodo = {
    id: newTodoId(),
    title,
    details,
    due_date,
    surface_at,
    priority,
    source: surface_at ? "scheduled" : "slack_slash",
    source_meta: { slack_user_id: payload.user.id },
    completed_at: null,
    remind_via_slack,
    created_at: now,
    updated_at: now,
  };
  await applyTodoOps(userKey, [{ type: "add", todo }]);
  console.log("[slack-views] Modal todo created", {
    userKey,
    todoId: todo.id,
    title: todo.title.slice(0, 80),
    surface_at: todo.surface_at,
    due_date: todo.due_date,
    priority: todo.priority,
  });
  const ackLines = [`:white_check_mark: Added to your to-dos: "${todo.title}"`];
  if (todo.surface_at) ackLines.push(`• Scheduled for ${todo.surface_at}`);
  if (todo.due_date) ackLines.push(`• Due ${todo.due_date}`);
  if (todo.priority) {
    ackLines.push(
      `• Priority: ${todo.priority[0].toUpperCase()}${todo.priority.slice(1)}`
    );
  }
  return { _ack_message: ackLines.join("\n") };
};

// ─── Dispatcher ──────────────────────────────────────────────────────

/** Look up + invoke the handler for a `view_submission` payload. When
 *  no handler is registered for the callback_id, log and respond with
 *  a clear close — Slack will dismiss the modal and we'll have a
 *  log line pointing at the missing handler.
 *
 *  The handler table is inlined here (rather than as a top-level
 *  const) so module load order doesn't matter — each `export const`
 *  handler defined later in the file is initialized by the time this
 *  function is *called*, even though the table is *referenced* at
 *  the top of the file. */
export async function dispatchViewSubmission(
  payload: ViewSubmissionPayload,
  userKey: string
): Promise<ViewSubmitResponse> {
  const handlers: Record<string, ViewSubmitHandler> = {
    [TODO_CREATE_CALLBACK_ID]: todoCreateHandler,
    [HUBSPOT_UPDATE_CSM_CALLBACK_ID]: hubspotUpdateCsmHandler,
    [FIND_CUSTOMER_VIEW_CALLBACK_ID]: findCustomerSubmitHandler,
    [ASSIGN_MODAL_CALLBACK_ID]: assignModalHandler,
  };
  const handler = handlers[payload.view.callback_id];
  if (!handler) {
    console.warn(
      "[slack-views] No handler for view callback_id",
      { callback_id: payload.view.callback_id }
    );
    return {};
  }
  return handler({ payload, userKey });
}

// ─── views.open helper ───────────────────────────────────────────────

// ─── HubSpot CSM update modal ────────────────────────────────────────
//
// Slash `/update-csm` opens a Block Kit modal with two fields:
//   - Workspace ID (text input — paste from the dashboard URL or the
//     workspace ID copy button in the expanded company view).
//   - CSM (static_select populated with the current HubSpot owners
//     list, value = owner_id, label = "Name <email>").
// On submit we resolve workspace_id → hubspot_company_id via the
// customer book and PATCH the company.
//
// Designed to be the template for additional HubSpot field updates
// (lifecycle stage, type, etc.) — copy the builder, add new blocks,
// register a new callback_id + handler in the registries below.

export const HUBSPOT_UPDATE_CSM_CALLBACK_ID = "hubspot_update_csm";

/** Build the CSM-update modal. Owners are passed in (we fetch them
 *  before opening the modal so the dropdown is populated immediately
 *  — Slack doesn't accept empty static_selects). */
export function buildHubspotUpdateCsmView(
  owners: HubspotOwner[],
  prefill?: { workspaceId?: string }
): Record<string, unknown> {
  // Cap at 100 — Slack's static_select hard limit. If beehiiv ever
  // grows past 100 active HubSpot owners we'd switch to external_select
  // (autocomplete from our backend). Today we have ~50-ish owners
  // total, well under the cap.
  const truncated = owners.slice(0, 100);
  const options = truncated.map((o) => ({
    text: {
      type: "plain_text",
      // Slack truncates option labels at 75 chars; we'd rather keep
      // the email visible than the full name.
      text: ((o.owner_name ? `${o.owner_name} ` : "") + `<${o.owner_email}>`).slice(0, 75),
    },
    value: o.owner_id,
  }));
  const omittedHint =
    owners.length > truncated.length
      ? ` (showing first 100 of ${owners.length})`
      : "";
  return {
    type: "modal",
    callback_id: HUBSPOT_UPDATE_CSM_CALLBACK_ID,
    title: { type: "plain_text", text: "Update CSM in HubSpot" },
    submit: { type: "plain_text", text: "Update" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              "Reassigns this company's HubSpot owner. The dashboard's *Refresh CSM from HubSpot* button on the customer row will pull the new value into the override store on next click.",
          },
        ],
      },
      {
        type: "input",
        block_id: "workspace_id",
        label: { type: "plain_text", text: "Workspace ID" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "Paste from the dashboard — Copy workspace ID button",
          },
          ...(prefill?.workspaceId
            ? { initial_value: prefill.workspaceId }
            : {}),
        },
        hint: {
          type: "plain_text",
          text: "UUID. Resolves to the company via the customer book.",
        },
      },
      {
        type: "input",
        block_id: "owner",
        label: {
          type: "plain_text",
          text: `New CSM (HubSpot owner)${omittedHint}`,
        },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "Pick a CSM",
          },
          options,
        },
      },
    ],
  };
}

/** Submission handler — workspace_id + owner_id → PATCH HubSpot. */
export const hubspotUpdateCsmHandler: ViewSubmitHandler = async ({
  payload,
  userKey,
}) => {
  const workspaceIdRaw = getTextValue(payload, "workspace_id");
  const ownerId = getSelectValue(payload, "owner");
  if (!workspaceIdRaw) {
    return {
      response_action: "errors",
      errors: { workspace_id: "Workspace ID is required." } as Record<
        string,
        string
      >,
    };
  }
  if (!ownerId) {
    return {
      response_action: "errors",
      errors: { owner: "Pick a CSM." } as Record<string, string>,
    };
  }
  const workspaceId = workspaceIdRaw.trim();

  // Look up the customer to find the hubspot_company_id. We don't
  // accept a raw HubSpot company ID directly because requiring a
  // dashboard-side anchor catches mistyped IDs cleanly (and lets us
  // surface the company name in the success message).
  let customer: Customer | null = null;
  try {
    const customers = await loadCustomers();
    customer =
      customers.find(
        (c) =>
          c.workspace_id === workspaceId ||
          c.workspace_id?.toLowerCase() === workspaceId.toLowerCase()
      ) ?? null;
  } catch (e) {
    console.error(
      "[slack-views] loadCustomers failed in hubspot_update_csm",
      e
    );
  }
  if (!customer) {
    return {
      response_action: "errors",
      errors: {
        workspace_id: `No customer found for workspace_id "${workspaceId}". Confirm the value (Copy workspace ID button on the dashboard).`,
      } as Record<string, string>,
    };
  }
  if (!customer.hubspot_company_id) {
    return {
      response_action: "errors",
      errors: {
        workspace_id: `${customer.company_name ?? customer.workspace_name ?? workspaceId} has no hubspot_company_id on file — can't reach HubSpot for it.`,
      } as Record<string, string>,
    };
  }

  try {
    await patchHubspotCompanyProperties(customer.hubspot_company_id, {
      hubspot_owner_id: ownerId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[slack-views] HubSpot PATCH failed", {
      userKey,
      workspaceId,
      ownerId,
      error: msg,
    });
    return {
      response_action: "errors",
      errors: {
        owner: `HubSpot PATCH failed: ${msg.slice(0, 150)}`,
      } as Record<string, string>,
    };
  }
  console.log("[slack-views] HubSpot CSM updated via Slack", {
    userKey,
    workspaceId,
    hubspot_company_id: customer.hubspot_company_id,
    new_owner_id: ownerId,
  });
  const companyName =
    customer.company_name ?? customer.workspace_name ?? workspaceId;
  return {
    _ack_message:
      `:white_check_mark: HubSpot CSM updated for *${companyName}*. ` +
      `Click "Refresh CSM from HubSpot" on the row to pull the new owner into the dashboard override store.`,
  };
};

// ─── Slash command registry ──────────────────────────────────────────
//
// Each entry maps a Slack slash command (with or without leading `/`)
// to a handler. The webhook dispatches by command name so multiple
// commands can coexist:
//
//   /todo         → opens the to-do modal (or inline parse if text given)
//   /update-csm   → opens the HubSpot CSM-update modal
//   /<anything>   → falls back to the to-do behavior (preserves the
//                   "register any name and it just works" UX we had
//                   when /todo was the only command)
//
// Adding a new slash flow: register the command name here with a
// handler that opens the relevant modal via `openSlackView(triggerId, view)`,
// then add the matching ViewSubmitHandler in VIEW_SUBMIT_HANDLERS so
// the submission lands somewhere.

export interface SlashHandlerContext {
  triggerId: string;
  inlineText: string;
  userKey: string;
  slackUserId: string;
  /** Slack's parent message timestamp when the slash command was
   *  invoked from inside a thread. Pass this through to the response
   *  (and any chat.postMessage call) so the bot's reply lands in the
   *  same thread instead of the channel root. */
  threadTs?: string;
  channelId: string;
}

/** Returns a Slack-formatted response object (ephemeral) — empty
 *  `{}` means "no ack needed" (the modal that just opened is the ack). */
export type SlashHandler = (
  ctx: SlashHandlerContext
) => Promise<{
  response_type?: "ephemeral" | "in_channel";
  text?: string;
  // Allow other Slack response fields for future expansion.
  [key: string]: unknown;
} | null>;

/**
 * Helper used by slash handlers to send their ephemeral reply.
 *
 * Slack's immediate slash-command response (the JSON body returned to
 * the original POST) does NOT support `thread_ts` — its ephemeral
 * always lands at the channel root, even when the command was invoked
 * from a thread. So when `threadTs` is present we side-channel the
 * reply via `chat.postEphemeral`, which DOES accept `thread_ts`, and
 * return null from the slash handler so the webhook responds with a
 * bare 200.
 *
 * When `threadTs` is absent we fall back to returning the response
 * object directly — Slack handles the standard channel-root display.
 */
export async function ephemeralReplyMaybeInThread(
  ctx: SlashHandlerContext,
  body: {
    text?: string;
    blocks?: Array<Record<string, unknown>>;
  }
): Promise<{ [key: string]: unknown } | null> {
  if (!ctx.threadTs) {
    return {
      response_type: "ephemeral",
      ...body,
    };
  }
  // chat.postEphemeral with thread_ts — the message renders inside
  // the thread, visible only to the user who ran the slash command.
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    // Fall back to channel-root ephemeral if the bot can't post.
    console.warn(
      "[slack-views] SLACK_BOT_TOKEN not set — can't post in-thread, falling back to channel root"
    );
    return {
      response_type: "ephemeral",
      ...body,
    };
  }
  try {
    const res = await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: ctx.channelId,
        user: ctx.slackUserId,
        thread_ts: ctx.threadTs,
        text: body.text,
        blocks: body.blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const j = (await res.json()) as { ok: boolean; error?: string };
    if (!j.ok) {
      // Common failure: bot isn't a member of the channel. Surface
      // that fallback so the user still sees their result (just in
      // the channel root rather than the thread).
      console.warn(
        "[slack-views] chat.postEphemeral with thread_ts failed",
        { error: j.error, channel: ctx.channelId }
      );
      return {
        response_type: "ephemeral",
        ...body,
        text:
          (body.text ?? "") +
          `\n_(Couldn't post in-thread: ${j.error ?? "unknown"}. Invite the bot to this channel for threaded replies.)_`,
      };
    }
  } catch (e) {
    console.warn(
      "[slack-views] chat.postEphemeral threw",
      e instanceof Error ? e.message : e
    );
    return {
      response_type: "ephemeral",
      ...body,
    };
  }
  // Posted in-thread successfully — return null so the immediate
  // slash response is empty (bare 200, no message at channel root).
  return null;
}

/** Handler for `/update-csm`. Always opens the modal — the inline
 *  text is ignored for v1. (Future: pre-fill the workspace_id if
 *  given.) */
export const hubspotUpdateCsmSlashHandler: SlashHandler = async (ctx) => {
  let owners: HubspotOwner[] = [];
  try {
    owners = await listHubspotOwners();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[slack-views] listHubspotOwners failed", msg);
    return {
      response_type: "ephemeral",
      text:
        "Couldn't fetch HubSpot owners list to build the form: " +
        msg.slice(0, 200) +
        ". Check HUBSPOT_ACCESS_TOKEN on the dashboard and the bot's HubSpot scopes.",
    };
  }
  if (owners.length === 0) {
    return {
      response_type: "ephemeral",
      text:
        "HubSpot returned 0 owners — can't build the CSM picker. Check the HubSpot integration is connected to the right portal.",
    };
  }
  const view = buildHubspotUpdateCsmView(owners, {
    workspaceId: ctx.inlineText.trim() || undefined,
  });
  const opened = await openSlackView(ctx.triggerId, view);
  if (!opened.ok) {
    return {
      response_type: "ephemeral",
      text:
        "Couldn't open the form: " +
        (opened.error ?? "unknown error"),
    };
  }
  return null;
};

// ─── /find — customer / publication search ───────────────────────────
//
// Slash `/find <query>` returns an ephemeral Slack message with a
// short snapshot of every customer whose company / workspace name
// matches the query. Minimal field set (per Jacob's pick): company
// name, workspace ID, publication IDs. Bounded to 5 matches so a
// vague query doesn't dump 200 rows into Slack.
//
// Publication IDs come straight from a single Postgres native query
// scoped to the matching workspace IDs — same approach as the AM
// "Copy pub IDs" button. Customer book lookup is in-process (loaded
// already by other code paths and cached).

const FIND_MAX_MATCHES = 5;
const FIND_MAX_PUBS_PER_WS = 25;

/** Footer-link block appended to every customer match in /find
 *  snapshots: "Open in dashboard ↗" + (when an owner email is on
 *  file) "Masquerade into workspace ↗". Returns a leading-newline
 *  prefixed mrkdwn fragment ready to concatenate onto a section
 *  text, or an empty string when neither link is available. */
function buildFooterLinks(
  dashboardHref: string | null,
  ownerEmail: string | null | undefined
): string {
  const links: string[] = [];
  if (dashboardHref) {
    links.push(`<${dashboardHref}|Open in dashboard ↗>`);
  }
  const masq = masqueradeUrl(ownerEmail);
  if (masq) {
    links.push(`<${masq}|Masquerade ↗>`);
  }
  return links.length > 0 ? `\n${links.join(" · ")}` : "";
}

/** Run a substring search against the customer book. Matches against
 *  company_name, workspace_name, workspace_id, and owner_email.
 *  Returns matches sorted by ARR descending (most-significant accounts
 *  first). The caller merges these with publication-name matches before
 *  capping at FIND_MAX_MATCHES.
 *
 *  Exported so the `@normbot renewal <query>` command in the Slack
 *  webhook can reuse the same fuzzy shape callers of `@normbot find`
 *  already get — otherwise a CSM would see two different match
 *  orderings depending on which command they typed. */
export function searchCustomers(customers: Customer[], query: string): Customer[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches: Customer[] = [];
  for (const c of customers) {
    const hay = [
      c.company_name,
      c.workspace_name,
      c.workspace_id,
      c.owner_email,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (hay.includes(q)) matches.push(c);
  }
  matches.sort((a, b) => (b.arr ?? 0) - (a.arr ?? 0));
  return matches;
}

/** Publication-name substring search against the publications table.
 *  Returns matched `{publication_id, name, organization_id}` rows; the
 *  caller maps organization_id back to a Customer via the customer
 *  book so the snapshot shows the company that owns the publication.
 *
 *  Why this is a separate query rather than joining publications into
 *  the customer book: q10600 doesn't carry publication names, and
 *  loading the full publications table client-side has already bitten
 *  us once via Metabase's 2000-row /api/dataset cap. Running ILIKE on
 *  the small subset Postgres returns is much cheaper than a full
 *  client-side scan. */
async function searchPublicationsByName(
  query: string,
  limit = 50
): Promise<
  Array<{ publication_id: string; name: string; organization_id: string }>
> {
  const q = query.trim();
  if (!q) return [];
  // Escape ILIKE-special chars (% and _) plus the SQL quote, then
  // wrap with leading/trailing % for substring match.
  const escaped = q.replace(/['\\%_]/g, (m) => "\\" + m);
  const pattern = `%${escaped}%`;
  const sql = `
    SELECT
      id::text              AS publication_id,
      name                  AS name,
      organization_id::text AS organization_id
    FROM public.publications
    WHERE deleted_at IS NULL
      AND organization_id IS NOT NULL
      AND name ILIKE '${pattern.replace(/'/g, "''")}'
    ORDER BY name
    LIMIT ${limit}
  `;
  try {
    const rows = await runNativeQuery(DB.POSTGRES, sql);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      publication_id: String(r.publication_id ?? ""),
      name: String(r.name ?? ""),
      organization_id: String(r.organization_id ?? ""),
    }));
  } catch (e) {
    console.warn(
      "[slack-views] searchPublicationsByName failed",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

export const findSlashHandler: SlashHandler = async (ctx) => {
  const query = ctx.inlineText.trim();
  if (!query) {
    return ephemeralReplyMaybeInThread(ctx, {
      text:
        "Add a search term — e.g. `/find acme` or `/find newsletter-name`. " +
        "Matches against company name, workspace name, workspace ID, owner email, *and* publication names.",
    });
  }
  let customers: Customer[] = [];
  try {
    customers = await loadCustomers();
  } catch (e) {
    return ephemeralReplyMaybeInThread(ctx, {
      text: `Couldn't load the customer book: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Two search paths run in parallel:
  //   - Customer book substring match (company / workspace / email)
  //   - Publications-table ILIKE match by publication name
  // The publication path returns organization_ids we then map back to
  // a Customer via the book. Results merge into a single list keyed
  // by workspace_id; publication-matched rows carry a list of which
  // publication names hit so the snapshot can annotate them.
  const [bookMatches, pubMatches] = await Promise.all([
    Promise.resolve(searchCustomers(customers, query)),
    searchPublicationsByName(query),
  ]);

  // Map workspace_id → array of matched publication names (for the
  // annotation). Used only when a customer was surfaced via the
  // publications path.
  const matchedPubsByWs = new Map<string, string[]>();
  for (const p of pubMatches) {
    const list = matchedPubsByWs.get(p.organization_id) ?? [];
    list.push(p.name);
    matchedPubsByWs.set(p.organization_id, list);
  }

  // Merge: start with book matches (highest priority), then append
  // publication matches whose workspace isn't already in the set.
  // Dedupe keyed by workspace_id; book matches keep their ARR-sorted
  // order at the top.
  const seenWs = new Set<string>();
  const merged: Customer[] = [];
  for (const c of bookMatches) {
    if (!c.workspace_id) continue;
    if (seenWs.has(c.workspace_id)) continue;
    seenWs.add(c.workspace_id);
    merged.push(c);
  }
  for (const p of pubMatches) {
    if (seenWs.has(p.organization_id)) continue;
    const c = customers.find((cu) => cu.workspace_id === p.organization_id);
    if (!c) continue; // pub exists but customer isn't in the book — skip
    seenWs.add(p.organization_id);
    merged.push(c);
  }

  if (merged.length === 0) {
    return ephemeralReplyMaybeInThread(ctx, {
      text: `No matches for "${query}". Tried company name, workspace name, workspace ID, owner email, and publication name.`,
    });
  }

  const shown = merged.slice(0, FIND_MAX_MATCHES);
  const ws2pubs = await fetchPublicationsForWorkspaces(
    shown
      .map((c) => c.workspace_id)
      .filter((id): id is string => Boolean(id))
  );

  const dashUrl = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app"
  ).replace(/\/+$/, "");

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:mag: *${merged.length} match${merged.length === 1 ? "" : "es"} for "${query}"*` +
          (merged.length > shown.length
            ? ` (showing top ${shown.length} — refine your search to narrow further)`
            : ""),
      },
    },
  ];
  for (const c of shown) {
    const wsId = c.workspace_id ?? "(no workspace_id)";
    const wsTitle =
      c.workspace_name && c.workspace_name !== c.company_name
        ? c.workspace_name
        : null;
    const pubs = c.workspace_id
      ? (ws2pubs.get(c.workspace_id) ?? []).slice(0, FIND_MAX_PUBS_PER_WS)
      : [];
    const totalPubs = c.workspace_id
      ? ws2pubs.get(c.workspace_id)?.length ?? 0
      : 0;
    // Render each pub as "Newsletter Name `pub_<id>`" on its own bullet
    // — easier to scan than a comma-separated string once titles are
    // mixed in. Untitled rows fall back to the bare ID.
    const pubLines =
      pubs.length === 0
        ? ["  _no publications found_"]
        : pubs.map((p) =>
            p.name
              ? `  • *${p.name}* \`pub_${p.id}\``
              : `  • \`pub_${p.id}\``
          );
    if (totalPubs > FIND_MAX_PUBS_PER_WS) {
      pubLines.push(
        `  _(+${totalPubs - FIND_MAX_PUBS_PER_WS} more)_`
      );
    }
    const name =
      c.company_name || c.workspace_name || "(unnamed customer)";
    const linkHref = c.workspace_id
      ? `${dashUrl}/account/${encodeURIComponent(c.workspace_id)}`
      : null;
    // If this customer surfaced via a publication-name match, show
    // which publication(s) hit so the CSM knows why the row appeared.
    const matchedPubs = c.workspace_id
      ? matchedPubsByWs.get(c.workspace_id) ?? []
      : [];
    const matchLine =
      matchedPubs.length > 0
        ? `\n_matched publication${matchedPubs.length === 1 ? "" : "s"}: ${matchedPubs
            .slice(0, 3)
            .map((n) => `*${n}*`)
            .join(", ")}${matchedPubs.length > 3 ? ` +${matchedPubs.length - 3} more` : ""}_`
        : "";
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${name}*\n` +
          `Workspace: ${wsTitle ? `*${wsTitle}* ` : ""}\`${wsId}\`\n` +
          `Publications:\n${pubLines.join("\n")}` +
          matchLine +
          buildFooterLinks(linkHref, c.owner_email),
      },
    });
  }

  // Append a "Share with channel" button so the user can publish the
  // (ephemeral) snapshot to the channel after they've reviewed it.
  // value carries enough context to re-run the search server-side
  // when the button fires — small enough to fit in Slack's 2000-char
  // button value limit.
  blocks.push({
    type: "actions",
    block_id: "find_actions",
    elements: [
      {
        type: "button",
        action_id: FIND_SHARE_ACTION_ID,
        text: {
          type: "plain_text",
          text: ":speech_balloon: Share with channel",
        },
        value: JSON.stringify({
          q: query,
          ch: ctx.channelId,
          th: ctx.threadTs ?? null,
        } satisfies FindShareActionValue),
      },
    ],
  });

  return ephemeralReplyMaybeInThread(ctx, {
    blocks,
    text: `${merged.length} match(es) for "${query}"`,
  });
};

// ─── /find: "Share with channel" button ──────────────────────────────

export const FIND_SHARE_ACTION_ID = "find_share";

interface FindShareActionValue {
  /** The original query — re-run server-side on click to avoid
   *  encoding the (potentially large) full result set in the
   *  button value. */
  q: string;
  /** The channel the slash command was invoked in. */
  ch: string;
  /** The thread the slash command was invoked in, or null for
   *  channel root. */
  th: string | null;
}

/**
 * Handler for the "Share with channel" button on a /find result.
 * Re-runs the search and posts the snapshot as an in-channel message
 * (visible to everyone) at the same thread location as the original
 * ephemeral. Returns a `response_url` payload that replaces the
 * ephemeral with a small confirmation.
 *
 * Why re-run instead of caching: button values are capped at 2000
 * chars and a result with 5 matches + publication lists can blow
 * past that easily. Re-running keeps the encoding simple, and search
 * is cheap.
 */
export async function handleFindShareAction(args: {
  value: string;
  responseUrl: string;
}): Promise<{ ok: boolean; error?: string }> {
  let parsed: FindShareActionValue;
  try {
    parsed = JSON.parse(args.value) as FindShareActionValue;
  } catch (e) {
    return {
      ok: false,
      error: `bad action value: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
  if (!parsed.q || !parsed.ch) {
    return { ok: false, error: "missing query or channel" };
  }

  // Re-run the search using the same logic as the slash handler.
  let customers: Customer[] = [];
  try {
    customers = await loadCustomers();
  } catch (e) {
    return {
      ok: false,
      error: `couldn't load customer book: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
  const [bookMatches, pubMatches] = await Promise.all([
    Promise.resolve(searchCustomers(customers, parsed.q)),
    searchPublicationsByName(parsed.q),
  ]);
  const matchedPubsByWs = new Map<string, string[]>();
  for (const p of pubMatches) {
    const list = matchedPubsByWs.get(p.organization_id) ?? [];
    list.push(p.name);
    matchedPubsByWs.set(p.organization_id, list);
  }
  const seenWs = new Set<string>();
  const merged: Customer[] = [];
  for (const c of bookMatches) {
    if (!c.workspace_id) continue;
    if (seenWs.has(c.workspace_id)) continue;
    seenWs.add(c.workspace_id);
    merged.push(c);
  }
  for (const p of pubMatches) {
    if (seenWs.has(p.organization_id)) continue;
    const c = customers.find((cu) => cu.workspace_id === p.organization_id);
    if (!c) continue;
    seenWs.add(p.organization_id);
    merged.push(c);
  }
  const shown = merged.slice(0, FIND_MAX_MATCHES);
  const ws2pubs = await fetchPublicationsForWorkspaces(
    shown
      .map((c) => c.workspace_id)
      .filter((id): id is string => Boolean(id))
  );

  const dashUrl = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app"
  ).replace(/\/+$/, "");

  // Compose the public-share blocks. Same shape as the ephemeral
  // (so the channel sees what the user saw), MINUS the share
  // button (no point sharing again from a public post).
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:mag: *Search results for "${parsed.q}"* — ${merged.length} match${merged.length === 1 ? "" : "es"}` +
          (merged.length > shown.length
            ? ` (showing top ${shown.length})`
            : ""),
      },
    },
  ];
  for (const c of shown) {
    const wsId = c.workspace_id ?? "(no workspace_id)";
    const wsTitle =
      c.workspace_name && c.workspace_name !== c.company_name
        ? c.workspace_name
        : null;
    const pubs = c.workspace_id
      ? (ws2pubs.get(c.workspace_id) ?? []).slice(0, FIND_MAX_PUBS_PER_WS)
      : [];
    const totalPubs = c.workspace_id
      ? ws2pubs.get(c.workspace_id)?.length ?? 0
      : 0;
    const pubLines =
      pubs.length === 0
        ? ["  _no publications found_"]
        : pubs.map((p) =>
            p.name
              ? `  • *${p.name}* \`pub_${p.id}\``
              : `  • \`pub_${p.id}\``
          );
    if (totalPubs > FIND_MAX_PUBS_PER_WS) {
      pubLines.push(`  _(+${totalPubs - FIND_MAX_PUBS_PER_WS} more)_`);
    }
    const name = c.company_name || c.workspace_name || "(unnamed customer)";
    const linkHref = c.workspace_id
      ? `${dashUrl}/account/${encodeURIComponent(c.workspace_id)}`
      : null;
    const matchedPubs = c.workspace_id
      ? matchedPubsByWs.get(c.workspace_id) ?? []
      : [];
    const matchLine =
      matchedPubs.length > 0
        ? `\n_matched publication${matchedPubs.length === 1 ? "" : "s"}: ${matchedPubs
            .slice(0, 3)
            .map((n) => `*${n}*`)
            .join(", ")}${matchedPubs.length > 3 ? ` +${matchedPubs.length - 3} more` : ""}_`
        : "";
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${name}*\n` +
          `Workspace: ${wsTitle ? `*${wsTitle}* ` : ""}\`${wsId}\`\n` +
          `Publications:\n${pubLines.join("\n")}` +
          matchLine +
          buildFooterLinks(linkHref, c.owner_email),
      },
    });
  }

  // Post publicly via chat.postMessage so it's visible to everyone
  // in the channel / thread. NOT response_url (which would replace
  // the ephemeral with a public message — we want both: the
  // ephemeral disappears, a fresh public message appears in-thread).
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  const postRes = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: parsed.ch,
      ...(parsed.th ? { thread_ts: parsed.th } : {}),
      text: `Search results for "${parsed.q}"`,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const postJson = (await postRes.json()) as { ok: boolean; error?: string };
  if (!postJson.ok) {
    // Surface the failure back to the user via response_url so they
    // know why their click didn't post anything. Common cause: bot
    // isn't a member of the channel.
    await fetch(args.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        replace_original: true,
        response_type: "ephemeral",
        text: `:warning: Couldn't share to channel: ${postJson.error ?? "unknown"}. Make sure the bot is in this channel.`,
      }),
    });
    return { ok: false, error: postJson.error };
  }

  // Replace the original ephemeral with a small confirmation so the
  // user sees that the share happened (the public post is right
  // below, but the ephemeral going to a "shared" state confirms it).
  await fetch(args.responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      replace_original: true,
      response_type: "ephemeral",
      text: `:speech_balloon: Shared with the channel.`,
    }),
  });
  return { ok: true };
}

// ─── Message-shortcut search flow (works in threads) ─────────────────
//
// Slack often blocks custom slash commands from firing inside threads
// at the workspace / app-config level — "not supported in threads."
// Message shortcuts have no such restriction: they hang off the "..."
// menu on every Slack message and dispatch the same way no matter
// where the message lives.
//
// Wire-up:
//   1. Admin creates a "Find customer" message shortcut in the Slack
//      app config with callback_id="find_customer_msg".
//   2. User picks the shortcut from any message's "..." menu (works
//      in threads).
//   3. Slack POSTs a message_action payload — handleShortcut opens
//      the search modal via views.open, stashing the channel +
//      thread_ts in private_metadata so the submission knows where
//      to reply.
//   4. User types a query + submits. The view_submission handler
//      runs the same merged search and posts the snapshot as an
//      ephemeral in the right channel + thread.

export const FIND_CUSTOMER_SHORTCUT_CALLBACK_ID = "find_customer_msg";
export const FIND_CUSTOMER_VIEW_CALLBACK_ID = "find_customer_submit";

/** Private-metadata blob carried from shortcut → modal → submission
 *  so the result can be posted into the right context. JSON-encoded
 *  in `view.private_metadata` (Slack's standard "carry context"
 *  channel for modal flows). */
interface FindCustomerPrivateMetadata {
  channel_id: string | null;
  thread_ts: string | null;
}

export function buildFindCustomerView(
  ctx: FindCustomerPrivateMetadata
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: FIND_CUSTOMER_VIEW_CALLBACK_ID,
    title: { type: "plain_text", text: "Find customer" },
    submit: { type: "plain_text", text: "Search" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify(ctx),
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: ctx.thread_ts
              ? "Results will post as a private (ephemeral) reply *inside this thread*."
              : "Results will post as a private (ephemeral) reply in this channel.",
          },
        ],
      },
      {
        type: "input",
        block_id: "query",
        label: { type: "plain_text", text: "Search term" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "Company name, workspace ID, owner email, or publication name",
          },
        },
      },
    ],
  };
}

/** Shortcut handler — opens the modal. Slack's shortcut payload
 *  carries trigger_id (for views.open) and, for message shortcuts,
 *  the original channel + message_ts so we can preserve thread context. */
export async function handleFindCustomerShortcut(args: {
  triggerId: string;
  channelId: string | null;
  threadTs: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const view = buildFindCustomerView({
    channel_id: args.channelId,
    thread_ts: args.threadTs,
  });
  return openSlackView(args.triggerId, view);
}

/** View-submission handler for the find-customer modal. Runs the
 *  same merged search as findSlashHandler, then posts the snapshot
 *  via chat.postEphemeral into the original channel + thread. */
export const findCustomerSubmitHandler: ViewSubmitHandler = async ({
  payload,
}) => {
  const query = getTextValue(payload, "query");
  if (!query) {
    return {
      response_action: "errors",
      errors: { query: "Add a search term." } as Record<string, string>,
    };
  }
  let meta: FindCustomerPrivateMetadata = {
    channel_id: null,
    thread_ts: null,
  };
  try {
    if (payload.view.private_metadata) {
      meta = JSON.parse(
        payload.view.private_metadata
      ) as FindCustomerPrivateMetadata;
    }
  } catch (e) {
    console.warn(
      "[slack-views] couldn't parse find-customer private_metadata",
      e
    );
  }
  if (!meta.channel_id) {
    // Shouldn't happen for message-shortcuts but DM the user just
    // in case so the modal isn't a silent dead-end.
    return {
      _ack_message:
        ":warning: Couldn't determine which channel to reply in. Try invoking the shortcut from a message inside the channel.",
    };
  }

  // Fire the search + ephemeral post asynchronously so the modal
  // submission ACKs Slack within the 3s window. The user will see
  // the result land in the thread shortly after the modal closes.
  void postFindCustomerResultInThread({
    query,
    channelId: meta.channel_id,
    threadTs: meta.thread_ts,
    slackUserId: payload.user.id,
  }).catch((e) => {
    console.error(
      "[slack-views] postFindCustomerResultInThread failed",
      e
    );
  });

  // No `_ack_message` here — the post happens in-channel/in-thread
  // anyway, the DM would be duplicative.
  return {};
};

/**
 * Build the standard /find result blocks for a query. Shared between
 * the slash handler, the message-shortcut modal submission, and the
 * @-mention handler so all three surfaces produce identical-looking
 * snapshots. Returns `null` when the search has zero matches — caller
 * decides how to convey "no results" since the right phrasing depends
 * on the entry point (ephemeral vs public thread reply, etc.).
 */
export async function buildFindResultBlocks(
  query: string
): Promise<Array<Record<string, unknown>> | null> {
  let customers: Customer[];
  try {
    customers = await loadCustomers();
  } catch {
    return null;
  }
  const [bookMatches, pubMatches] = await Promise.all([
    Promise.resolve(searchCustomers(customers, query)),
    searchPublicationsByName(query),
  ]);
  const matchedPubsByWs = new Map<string, string[]>();
  for (const p of pubMatches) {
    const list = matchedPubsByWs.get(p.organization_id) ?? [];
    list.push(p.name);
    matchedPubsByWs.set(p.organization_id, list);
  }
  const seenWs = new Set<string>();
  const merged: Customer[] = [];
  for (const c of bookMatches) {
    if (!c.workspace_id) continue;
    if (seenWs.has(c.workspace_id)) continue;
    seenWs.add(c.workspace_id);
    merged.push(c);
  }
  for (const p of pubMatches) {
    if (seenWs.has(p.organization_id)) continue;
    const c = customers.find((cu) => cu.workspace_id === p.organization_id);
    if (!c) continue;
    seenWs.add(p.organization_id);
    merged.push(c);
  }
  if (merged.length === 0) return null;
  const shown = merged.slice(0, FIND_MAX_MATCHES);
  const ws2pubs = await fetchPublicationsForWorkspaces(
    shown
      .map((c) => c.workspace_id)
      .filter((id): id is string => Boolean(id))
  );
  const dashUrl = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app"
  ).replace(/\/+$/, "");
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:mag: *${merged.length} match${merged.length === 1 ? "" : "es"} for "${query}"*` +
          (merged.length > shown.length
            ? ` (showing top ${shown.length})`
            : ""),
      },
    },
  ];
  for (const c of shown) {
    const wsId = c.workspace_id ?? "(no workspace_id)";
    const wsTitle =
      c.workspace_name && c.workspace_name !== c.company_name
        ? c.workspace_name
        : null;
    const pubs = c.workspace_id
      ? (ws2pubs.get(c.workspace_id) ?? []).slice(0, FIND_MAX_PUBS_PER_WS)
      : [];
    const totalPubs = c.workspace_id
      ? ws2pubs.get(c.workspace_id)?.length ?? 0
      : 0;
    const pubLines =
      pubs.length === 0
        ? ["  _no publications found_"]
        : pubs.map((p) =>
            p.name
              ? `  • *${p.name}* \`pub_${p.id}\``
              : `  • \`pub_${p.id}\``
          );
    if (totalPubs > FIND_MAX_PUBS_PER_WS) {
      pubLines.push(`  _(+${totalPubs - FIND_MAX_PUBS_PER_WS} more)_`);
    }
    const name = c.company_name || c.workspace_name || "(unnamed customer)";
    const linkHref = c.workspace_id
      ? `${dashUrl}/account/${encodeURIComponent(c.workspace_id)}`
      : null;
    const matchedPubs = c.workspace_id
      ? matchedPubsByWs.get(c.workspace_id) ?? []
      : [];
    const matchLine =
      matchedPubs.length > 0
        ? `\n_matched publication${matchedPubs.length === 1 ? "" : "s"}: ${matchedPubs
            .slice(0, 3)
            .map((n) => `*${n}*`)
            .join(", ")}${matchedPubs.length > 3 ? ` +${matchedPubs.length - 3} more` : ""}_`
        : "";
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${name}*\n` +
          `Workspace: ${wsTitle ? `*${wsTitle}* ` : ""}\`${wsId}\`\n` +
          `Publications:\n${pubLines.join("\n")}` +
          matchLine +
          buildFooterLinks(linkHref, c.owner_email),
      },
    });
  }
  return blocks;
}

/**
 * Build a compact Block Kit response for `@bot stripe <query>` /
 * `stripe <query>` (DM). Same search machinery as buildFindResultBlocks
 * but the per-row output is narrowly scoped — company name and a
 * single Stripe-dashboard link — since the CSM typically wants to
 * click through, not skim publication metadata. Caps the visible
 * matches at 5 like /find, drops customers that have no
 * stripe_customer_id (the dashboard URL requires one).
 *
 * Returns `null` when there are zero usable matches so the caller can
 * print a contextual "no matches" message.
 */
export async function buildStripeResultBlocks(
  query: string
): Promise<Array<Record<string, unknown>> | null> {
  let customers: Customer[];
  try {
    customers = await loadCustomers();
  } catch {
    return null;
  }
  // Reuse the same merged book + publication-name search as /find so
  // `stripe newsletter-name` resolves to the parent workspace and its
  // Stripe link, same as you'd expect from /find.
  const [bookMatches, pubMatches] = await Promise.all([
    Promise.resolve(searchCustomers(customers, query)),
    searchPublicationsByName(query),
  ]);
  const seenWs = new Set<string>();
  const merged: Customer[] = [];
  for (const c of bookMatches) {
    if (!c.workspace_id) continue;
    if (seenWs.has(c.workspace_id)) continue;
    seenWs.add(c.workspace_id);
    merged.push(c);
  }
  for (const p of pubMatches) {
    if (seenWs.has(p.organization_id)) continue;
    const c = customers.find((cu) => cu.workspace_id === p.organization_id);
    if (!c) continue;
    seenWs.add(p.organization_id);
    merged.push(c);
  }
  // Drop matches without a Stripe customer id — the whole point of
  // this response is the link, and an entry without one is more
  // confusing than helpful.
  const withStripe = merged.filter((c) => c.stripe_customer_id);
  if (withStripe.length === 0) return null;
  const shown = withStripe.slice(0, FIND_MAX_MATCHES);

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:credit_card: *${withStripe.length} Stripe match${withStripe.length === 1 ? "" : "es"} for "${query}"*` +
          (withStripe.length > shown.length
            ? ` (showing top ${shown.length})`
            : ""),
      },
    },
  ];
  for (const c of shown) {
    const name = c.company_name || c.workspace_name || "(unnamed customer)";
    const stripeHref = stripeCustomerUrl(c.stripe_customer_id);
    if (!stripeHref) continue;
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${name}*\n` +
          `Stripe: \`${c.stripe_customer_id}\`\n` +
          `<${stripeHref}|Open in Stripe ↗>`,
      },
    });
  }
  return blocks;
}

/** Run the merged book + publications search and post the result as
 *  an ephemeral in the target channel + thread. Mirrors the layout
 *  of findSlashHandler's response. */
async function postFindCustomerResultInThread(args: {
  query: string;
  channelId: string;
  threadTs: string | null;
  slackUserId: string;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn(
      "[slack-views] postFindCustomerResultInThread: no SLACK_BOT_TOKEN"
    );
    return;
  }
  let customers: Customer[] = [];
  try {
    customers = await loadCustomers();
  } catch (e) {
    await postEphemeralFallback(token, args, {
      text: `Couldn't load the customer book: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
    return;
  }
  const [bookMatches, pubMatches] = await Promise.all([
    Promise.resolve(searchCustomers(customers, args.query)),
    searchPublicationsByName(args.query),
  ]);
  const matchedPubsByWs = new Map<string, string[]>();
  for (const p of pubMatches) {
    const list = matchedPubsByWs.get(p.organization_id) ?? [];
    list.push(p.name);
    matchedPubsByWs.set(p.organization_id, list);
  }
  const seenWs = new Set<string>();
  const merged: Customer[] = [];
  for (const c of bookMatches) {
    if (!c.workspace_id) continue;
    if (seenWs.has(c.workspace_id)) continue;
    seenWs.add(c.workspace_id);
    merged.push(c);
  }
  for (const p of pubMatches) {
    if (seenWs.has(p.organization_id)) continue;
    const c = customers.find((cu) => cu.workspace_id === p.organization_id);
    if (!c) continue;
    seenWs.add(p.organization_id);
    merged.push(c);
  }
  if (merged.length === 0) {
    await postEphemeralFallback(token, args, {
      text: `No matches for "${args.query}".`,
    });
    return;
  }
  const shown = merged.slice(0, FIND_MAX_MATCHES);
  const ws2pubs = await fetchPublicationsForWorkspaces(
    shown
      .map((c) => c.workspace_id)
      .filter((id): id is string => Boolean(id))
  );
  const dashUrl = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app"
  ).replace(/\/+$/, "");

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:mag: *${merged.length} match${merged.length === 1 ? "" : "es"} for "${args.query}"*` +
          (merged.length > shown.length
            ? ` (showing top ${shown.length})`
            : ""),
      },
    },
  ];
  for (const c of shown) {
    const wsId = c.workspace_id ?? "(no workspace_id)";
    const wsTitle =
      c.workspace_name && c.workspace_name !== c.company_name
        ? c.workspace_name
        : null;
    const pubs = c.workspace_id
      ? (ws2pubs.get(c.workspace_id) ?? []).slice(0, FIND_MAX_PUBS_PER_WS)
      : [];
    const totalPubs = c.workspace_id
      ? ws2pubs.get(c.workspace_id)?.length ?? 0
      : 0;
    const pubLines =
      pubs.length === 0
        ? ["  _no publications found_"]
        : pubs.map((p) =>
            p.name
              ? `  • *${p.name}* \`pub_${p.id}\``
              : `  • \`pub_${p.id}\``
          );
    if (totalPubs > FIND_MAX_PUBS_PER_WS) {
      pubLines.push(`  _(+${totalPubs - FIND_MAX_PUBS_PER_WS} more)_`);
    }
    const name =
      c.company_name || c.workspace_name || "(unnamed customer)";
    const linkHref = c.workspace_id
      ? `${dashUrl}/account/${encodeURIComponent(c.workspace_id)}`
      : null;
    const matchedPubs = c.workspace_id
      ? matchedPubsByWs.get(c.workspace_id) ?? []
      : [];
    const matchLine =
      matchedPubs.length > 0
        ? `\n_matched publication${matchedPubs.length === 1 ? "" : "s"}: ${matchedPubs
            .slice(0, 3)
            .map((n) => `*${n}*`)
            .join(", ")}${matchedPubs.length > 3 ? ` +${matchedPubs.length - 3} more` : ""}_`
        : "";
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${name}*\n` +
          `Workspace: ${wsTitle ? `*${wsTitle}* ` : ""}\`${wsId}\`\n` +
          `Publications:\n${pubLines.join("\n")}` +
          matchLine +
          buildFooterLinks(linkHref, c.owner_email),
      },
    });
  }
  // Same "Share with channel" button so the user can publish the
  // ephemeral if they want everyone in the thread to see it.
  blocks.push({
    type: "actions",
    block_id: "find_actions",
    elements: [
      {
        type: "button",
        action_id: FIND_SHARE_ACTION_ID,
        text: {
          type: "plain_text",
          text: ":speech_balloon: Share with channel",
        },
        value: JSON.stringify({
          q: args.query,
          ch: args.channelId,
          th: args.threadTs,
        } satisfies FindShareActionValue),
      },
    ],
  });

  const res = await fetch("https://slack.com/api/chat.postEphemeral", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channelId,
      user: args.slackUserId,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      text: `${merged.length} match(es) for "${args.query}"`,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const j = (await res.json()) as { ok: boolean; error?: string };
  if (!j.ok) {
    console.warn(
      "[slack-views] find-customer ephemeral post failed",
      { error: j.error, channel: args.channelId }
    );
    // Last-resort: DM the user the result so they at least see it.
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: args.slackUserId,
        text: `Couldn't post in-thread (${j.error ?? "unknown"}). Here's the result:`,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
  }
}

async function postEphemeralFallback(
  token: string,
  args: {
    channelId: string;
    threadTs: string | null;
    slackUserId: string;
  },
  body: { text: string }
): Promise<void> {
  await fetch("https://slack.com/api/chat.postEphemeral", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channelId,
      user: args.slackUserId,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      text: body.text,
    }),
  });
}

/** Slash command registry. Match is case-insensitive on the command
 *  name (with or without the leading `/`). */
export const SLASH_HANDLERS: Record<string, SlashHandler> = {
  "update-csm": hubspotUpdateCsmSlashHandler,
  find: findSlashHandler,
  // Convenience aliases — admins sometimes register slightly different
  // names in Slack. All hit the same handler.
  lookup: findSlashHandler,
  search: findSlashHandler,
  "ent-search": findSlashHandler,
  "find-customer": findSlashHandler,
  "search-customer": findSlashHandler,
};

/** Look up a slash handler for a given command name. Returns null
 *  when no entry matches; the webhook falls back to the to-do flow. */
export function lookupSlashHandler(commandRaw: string): SlashHandler | null {
  const key = commandRaw.replace(/^\//, "").trim().toLowerCase();
  return SLASH_HANDLERS[key] ?? null;
}

/** Per-workspace publication record returned by
 *  fetchPublicationsForWorkspaces. `id` is the raw UUID; callers
 *  prepend `pub_` for display. */
interface PubRow {
  id: string;
  name: string;
}

/**
 * Single-shot Postgres query: pull every non-deleted publication for
 * the given workspaces, including the publication name. Used by the
 * `/find` slash command so the snapshot can show "Daily Brew \`pub_…\`"
 * instead of just the bare ID.
 *
 * Returns a map keyed by workspace_id → array of {id, name} records.
 */
async function fetchPublicationsForWorkspaces(
  workspaceIds: string[]
): Promise<Map<string, PubRow[]>> {
  const result = new Map<string, PubRow[]>();
  if (workspaceIds.length === 0) return result;
  const safe = workspaceIds.map((id) => `'${id.replace(/'/g, "''")}'`);
  const sql = `
    SELECT
      id::text              AS publication_id,
      name                  AS name,
      organization_id::text AS organization_id
    FROM public.publications
    WHERE organization_id IN (${safe.join(",")})
      AND deleted_at IS NULL
    ORDER BY organization_id, name
  `;
  try {
    const rows = await runNativeQuery(DB.POSTGRES, sql);
    for (const r of rows as Array<Record<string, unknown>>) {
      const ws = String(r.organization_id ?? "");
      const pub = String(r.publication_id ?? "");
      const name = String(r.name ?? "");
      if (!ws || !pub) continue;
      const list = result.get(ws) ?? [];
      list.push({ id: pub, name });
      result.set(ws, list);
    }
  } catch (e) {
    console.warn(
      "[slack-views] fetchPublicationsForWorkspaces failed",
      e instanceof Error ? e.message : e
    );
  }
  return result;
}

/** Open a modal in Slack. `trigger_id` comes from the originating
 *  slash command / interactive action and is only valid for ~3 seconds,
 *  so this must be called immediately on receipt. */
export async function openSlackView(
  triggerId: string,
  view: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  try {
    const r = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });
    const j = (await r.json()) as { ok: boolean; error?: string };
    if (!j.ok) {
      console.warn("[slack-views] views.open failed", { error: j.error });
    }
    return j;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Renewal Confirm interactive button ───────────────────────────────
//
// The `@normbot renewal <query>` command shows a candidate list of
// up to 5 customer matches. Each row has a Confirm button whose
// `value` is `RenewalConfirmActionValue` (JSON) — carrying the
// workspace_id + who requested + where the mention came from.
// Handled in the Slack webhook's `handleBlockActions` under this
// action_id.

export const RENEWAL_CONFIRM_ACTION_ID = "renewal_confirm";

export interface RenewalConfirmActionValue {
  workspace_id: string;
  requester_slack_id: string;
  origin_channel: string;
  origin_thread_ts: string;
}

const RENEWAL_MAX_MATCHES = 5;

/** Format ARR as "$12.3K/yr" — compact enough for the section body. */
function shortArr(arr: number | null | undefined): string {
  if (arr == null || !Number.isFinite(arr)) return "—";
  if (arr === 0) return "$0/yr";
  if (arr >= 1_000_000) {
    return `$${(arr / 1_000_000).toFixed(1).replace(/\.0$/, "")}M/yr`;
  }
  if (arr >= 1000) {
    return `$${(arr / 1000).toFixed(1).replace(/\.0$/, "")}K/yr`;
  }
  return `$${arr.toLocaleString()}/yr`;
}

function formatDateForRenewalPicker(iso: string | null): string {
  if (!iso) return "no date on file";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "no date on file";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Build the Block Kit blocks for `@normbot renewal <query>` — the
 * ephemeral candidate picker the CSM sees before we open a pricing
 * thread. Up to 5 rows, each with a Confirm button carrying
 * {workspace_id, requester_slack_id, origin_channel, origin_thread_ts}
 * so the block_actions handler has everything it needs to post the
 * kickoff message + persist the thread ts.
 *
 * `renewalDateFor` is injected so the caller (webhook) can reuse
 * the same `nextRenewalDate` helper the milestone engine uses —
 * keeps the picker's "Renewal date" column in agreement with the
 * dashboard and the sweep.
 *
 * Returns null when the fuzzy search produced zero matches so the
 * webhook can send a contextual "no results" reply.
 */
export async function buildRenewalCandidateBlocks(args: {
  query: string;
  requesterSlackId: string;
  originChannel: string;
  originThreadTs: string;
  renewalDateFor: (c: Customer) => string | null;
  lifecycleStageFor: (c: Customer) => string | null;
}): Promise<Array<Record<string, unknown>> | null> {
  const {
    query,
    requesterSlackId,
    originChannel,
    originThreadTs,
    renewalDateFor,
    lifecycleStageFor,
  } = args;
  let customers: Customer[];
  try {
    customers = await loadCustomers();
  } catch {
    return null;
  }
  const matches = searchCustomers(customers, query).filter(
    (c) => c.workspace_id
  );
  if (matches.length === 0) return null;
  const shown = matches.slice(0, RENEWAL_MAX_MATCHES);

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:handshake: *${matches.length} candidate${matches.length === 1 ? "" : "s"} for "${query}"*` +
          (matches.length > shown.length
            ? ` (showing top ${shown.length} by ARR)`
            : "") +
          `\nPick the account and I'll open the pricing thread in the configured Renewals channel.`,
      },
    },
  ];

  for (const c of shown) {
    const name = c.company_name || c.workspace_name || "(unnamed customer)";
    const owner = c.customer_success_manager
      ? c.customer_success_manager.replace(/_/g, " ")
      : "unassigned";
    const plan = c.stripe_plan ?? "—";
    const arr = shortArr(c.arr);
    const renewal = formatDateForRenewalPicker(renewalDateFor(c));
    const stage = lifecycleStageFor(c) ?? "unset";
    const buttonValue: RenewalConfirmActionValue = {
      workspace_id: c.workspace_id as string,
      requester_slack_id: requesterSlackId,
      origin_channel: originChannel,
      origin_thread_ts: originThreadTs,
    };
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${name}*  ·  💰 ${arr}  ·  Plan: *${plan}*\n` +
          `Owner: ${owner}  ·  Renewal: *${renewal}*\n` +
          `Current stage: *${stage}*`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Confirm", emoji: true },
        style: "primary",
        action_id: RENEWAL_CONFIRM_ACTION_ID,
        value: JSON.stringify(buttonValue),
      },
    });
  }

  if (matches.length > shown.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${matches.length - shown.length} more match${
            matches.length - shown.length === 1 ? "" : "es"
          } weren't shown — narrow the query if none of the above are right._`,
        },
      ],
    });
  }

  return blocks;
}
