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
    ],
  };
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
  // Empty response closes the modal. We DM the user separately via
  // the route so they get a permanent confirmation in their DM
  // history instead of just the modal disappearing.
  return {};
};

// ─── Dispatcher ──────────────────────────────────────────────────────

/** Registry: callback_id → submit handler. Add new entries here when
 *  introducing a new modal flow. The webhook router calls
 *  `dispatchViewSubmission` and gets back the response Slack expects. */
export const VIEW_SUBMIT_HANDLERS: Record<string, ViewSubmitHandler> = {
  [TODO_CREATE_CALLBACK_ID]: todoCreateHandler,
};

/** Look up + invoke the handler for a `view_submission` payload. When
 *  no handler is registered for the callback_id, log and respond with
 *  a clear close — Slack will dismiss the modal and we'll have a
 *  log line pointing at the missing handler. */
export async function dispatchViewSubmission(
  payload: ViewSubmissionPayload,
  userKey: string
): Promise<ViewSubmitResponse> {
  const handler = VIEW_SUBMIT_HANDLERS[payload.view.callback_id];
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
