/**
 * Slack @bot renewal-cycle — SCAFFOLD.
 *
 * Companion to the existing @bot assign flow but scoped to the
 * renewal-cycle motion. Same three-stage pattern (mirrors
 * slack-assign.ts):
 *
 *   1. `@bot renewal-cycle` in a thread → postThreadReply with a
 *      button (buildRenewalCycleButtonBlocks). Slack only mints
 *      trigger_ids on user-initiated interactions (slash commands
 *      or block-action clicks), so we can't open the modal
 *      directly from the app_mention event — the button click is
 *      what gives us a fresh trigger_id.
 *
 *   2. Button click → block-action handler in slack-webhook/route.ts
 *      decodes the ThreadContext stamped in `action.value` and
 *      calls openRenewalCycleModal({ triggerId, threadContext }).
 *
 *   3. Submit → dispatchViewSubmission in slack-views.ts routes on
 *      `callback_id === RENEWAL_CYCLE_MODAL_CALLBACK_ID` and hands
 *      the payload to renewalCycleModalHandler. That handler is
 *      where all the business logic lands.
 *
 * The view builder + submit handler here are intentionally
 * MINIMAL — build out the blocks + form-value shape + side effects
 * to match the desired flow. See slack-assign.ts for the fully
 * fleshed-out reference implementation.
 */

import type {
  ViewSubmissionPayload,
  ViewSubmitHandler,
  ViewSubmitResponse,
} from "./slack-views";

// ─── Constants ────────────────────────────────────────────────────────

/** action_id on the button we post from the app_mention branch.
 *  The webhook's block_actions dispatcher matches on this. */
export const RENEWAL_CYCLE_OPEN_BUTTON_ACTION_ID = "renewal_cycle_open_modal";

/** callback_id on the modal view itself. dispatchViewSubmission()
 *  in slack-views.ts routes view_submission events to the handler
 *  registered under this key. */
export const RENEWAL_CYCLE_MODAL_CALLBACK_ID = "renewal_cycle_modal";

// ─── Thread context ──────────────────────────────────────────────────

/** Round-tripped through the button's `value` (JSON-encoded), then
 *  decoded in the block-actions handler and passed straight into
 *  the modal via private_metadata. Any per-user or per-thread
 *  context the submit handler needs (channel/thread to reply into,
 *  the requester's email for Drive/Gmail scopes, etc.) belongs on
 *  this object. */
export interface RenewalCycleThreadContext {
  channel: string;
  thread_ts: string;
  requester_user: string;
}

// ─── Button (posted as thread reply) ──────────────────────────────────

/** Blocks for the "Open renewal-cycle form" button that fronts the
 *  modal. The user clicks this from the app_mention thread to get
 *  a trigger_id — see the file header for the trigger_id-lifecycle
 *  reason we can't skip this step. */
export function buildRenewalCycleButtonBlocks(
  ctx: RenewalCycleThreadContext
): Array<Record<string, unknown>> {
  const value = JSON.stringify(ctx);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Renewal cycle form* — click below to open the modal.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: RENEWAL_CYCLE_OPEN_BUTTON_ACTION_ID,
          text: { type: "plain_text", text: "📄 Open Renewal Cycle form" },
          style: "primary",
          value,
        },
      ],
    },
  ];
}

// ─── Modal (build your Block Kit view here) ──────────────────────────

/**
 * Return the Block Kit view JSON for the renewal-cycle modal.
 *
 * Reference implementation (assign flow): src/lib/integrations/slack-assign.ts:410
 * Block Kit builder for live preview: https://app.slack.com/block-kit-builder
 *
 * The `callback_id` + `private_metadata` are the load-bearing
 * plumbing; everything inside `blocks` is yours to shape. If you
 * add a static_select, note Slack's 100-option hard cap — fetch
 * the option data BEFORE opening the modal (see openAssignModal's
 * listHubspotOwners call for the pattern).
 */
export function buildRenewalCycleView(
  threadContext: RenewalCycleThreadContext
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: RENEWAL_CYCLE_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(threadContext),
    title: { type: "plain_text", text: "Renewal cycle" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      // TODO: fill in blocks. Example scaffold below — replace with
      // whatever the renewal-cycle motion needs. Each `input` block's
      // `block_id` is what readRenewalCycleForm() reads state.values
      // under; the `action_id` defaults to "value" per the assign
      // module's convention (matches getTextValue/getSelectValue's
      // default second arg in slack-views.ts).
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "_Scaffold — build out the form fields inside `buildRenewalCycleView`._",
          },
        ],
      },
    ],
  };
}

// ─── views.open helper ───────────────────────────────────────────────

/**
 * Fetch anything the modal needs to prefill (owners, options, etc.),
 * build the view, then POST to https://slack.com/api/views.open
 * with the trigger_id.
 *
 * Mirrors openAssignModal at slack-assign.ts:510 — same shape, same
 * error surface. Keep the async prefetch INSIDE this function
 * (don't push it into the block-actions handler) so a Slack outage
 * or a slow HubSpot call surfaces one error path.
 */
export async function openRenewalCycleModal(args: {
  triggerId: string;
  threadContext: RenewalCycleThreadContext;
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" };

  // TODO: prefetch data the view needs (options lists, current CSM,
  // etc.) and pass into buildRenewalCycleView.

  const view = buildRenewalCycleView(args.threadContext);

  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: args.triggerId, view }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) {
    console.error("[slack-renewal-cycle] views.open failed", json);
    return { ok: false, error: json.error ?? "views.open failed" };
  }
  return { ok: true };
}

// ─── Modal submission ────────────────────────────────────────────────

/** Shape of the fields read out of the view state. Keep in sync
 *  with the block_ids you add in buildRenewalCycleView. Return
 *  { ok: false, errors } when any required field is missing so
 *  Slack renders the field-level error and keeps the modal open. */
interface RenewalCycleFormValues {
  // TODO: add fields as the view grows. Example:
  // renewalDate: string;
  // priceChangePct: number;
  // notes: string | null;
}

type ReadResult =
  | { ok: true; values: RenewalCycleFormValues }
  | { ok: false; errors: Record<string, string> };

/** Extract form values from the submitted view. Use the
 *  getTextValue / getDateValue / getSelectValue helpers from
 *  slack-views.ts — they handle the block_id → action_id → value
 *  drill-down and null-vs-empty semantics consistently. */
function readRenewalCycleForm(_payload: ViewSubmissionPayload): ReadResult {
  // TODO: pluck each field out of _payload.view.state.values and
  // build up either { ok: true, values } or { ok: false, errors }.
  return { ok: true, values: {} };
}

/**
 * Modal-submit entry point.
 *
 * Registered in dispatchViewSubmission() in slack-views.ts under
 * RENEWAL_CYCLE_MODAL_CALLBACK_ID. All business logic lands here:
 * read the form, do the writes (HubSpot / KV / Slack / Drive), and
 * post a thread confirmation.
 *
 * Response contract (from slack-views.ts):
 *   - {} → close modal silently
 *   - { response_action: "errors", errors: {...} } → keep open,
 *     surface field-level errors
 *   - { _ack_message: "..." } → send an ephemeral DM after close
 *     (the route reads + strips this before forwarding)
 */
export const renewalCycleModalHandler: ViewSubmitHandler = async ({
  payload,
}) => {
  const form = readRenewalCycleForm(payload);
  if (!form.ok) {
    return { response_action: "errors", errors: form.errors } as ViewSubmitResponse;
  }

  // Decoded from the view's private_metadata (which we stamped in
  // buildRenewalCycleView). Reach for it whenever the submit handler
  // needs to post back to the originating thread or attribute the
  // action to the requester.
  let _threadContext: RenewalCycleThreadContext = {
    channel: "",
    thread_ts: "",
    requester_user: "",
  };
  try {
    _threadContext = JSON.parse(payload.view.private_metadata ?? "{}");
  } catch {
    // Non-fatal — degrade to no thread reply.
  }

  // TODO: business logic goes here (HubSpot / KV writes, thread
  // reply via postThreadReply from slack-inbound, etc.).

  return {
    _ack_message:
      "Renewal cycle form submitted. (Scaffold — wire the real side effects in renewalCycleModalHandler.)",
  };
};
