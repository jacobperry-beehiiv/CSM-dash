/**
 * Block Kit + interactivity glue for the per-account digest buttons.
 *
 * Each "Send digest" manual run posts a parent message per CSM, then
 * one threaded reply per account in that CSM's review queue. Each
 * threaded reply has two buttons — "Reach Out Approved" and "Skip" —
 * that write the CSM's review_state for that (workspace_id, workflow)
 * tuple into the dashboard's KV store.
 *
 * The status is intentionally NOT echoed back into Slack — the
 * dashboard is the single source of truth, and the threaded message
 * stays clickable so re-clicks are harmless (idempotent writes).
 * The interactivity handler responds ephemerally only to the
 * clicker so they know the write landed.
 *
 * Slack app config required:
 *   - Interactivity & Shortcuts → ON
 *   - Request URL → https://csm-dash.vercel.app/api/slack-webhook
 *     (the existing handler dispatches block_actions by action_id)
 *   - SLACK_SIGNING_SECRET set in env (already required for slash
 *     commands, so this is no new config in practice)
 */

import { setReviewState } from "../data/review-states";
import type { ReviewWorkflow } from "../data/review-states-types";

/** Two action_ids — one per button. The handler in slack-webhook
 *  dispatches by these. Keep them stable: changing the string
 *  invalidates every still-pending message currently sitting in
 *  Slack threads. */
export const DIGEST_REACH_OUT_ACTION_ID = "digest_review_reach_out";
export const DIGEST_SKIP_ACTION_ID = "digest_review_skip";

/** What we encode in each button's `value` field. Slack returns this
 *  verbatim on the click payload, so it has to be everything the
 *  handler needs to write the right KV entry. */
interface ButtonValue {
  ws: string;
  wf: ReviewWorkflow;
}

/** Build the Block Kit blocks for one threaded per-account reply.
 *  Title is the company name; below it, two buttons side-by-side. */
export function buildDigestAccountBlocks(args: {
  workspaceId: string;
  workspaceName: string;
  workflow: ReviewWorkflow;
}): unknown[] {
  const value: ButtonValue = { ws: args.workspaceId, wf: args.workflow };
  const encoded = JSON.stringify(value);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlack(args.workspaceName)}*`,
      },
    },
    {
      type: "actions",
      // Stable block_id helps if we ever want to look up the message
      // by what's inside it. Per-workspace so two threaded replies
      // in the same thread don't collide.
      block_id: `digest_review:${args.workspaceId}:${args.workflow}`,
      elements: [
        {
          type: "button",
          action_id: DIGEST_REACH_OUT_ACTION_ID,
          text: { type: "plain_text", text: "Reach Out Approved" },
          style: "primary",
          value: encoded,
        },
        {
          type: "button",
          action_id: DIGEST_SKIP_ACTION_ID,
          text: { type: "plain_text", text: "Skip" },
          value: encoded,
        },
      ],
    },
  ];
}

/** Slack mrkdwn is permissive but `<`, `>`, `&` need escaping. */
function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Click handler — invoked from the block_actions dispatcher in
 *  slack-webhook/route.ts. Writes review_state to KV and returns a
 *  short ephemeral message for the clicker.
 *
 *  Returns the ephemeral response text the route should reply with;
 *  Slack renders it as a private "Only visible to you" line. */
export async function handleDigestButtonClick(args: {
  actionId: string;
  buttonValue: string;
  slackUserId: string | null;
}): Promise<{ ephemeralText: string }> {
  let parsed: ButtonValue;
  try {
    parsed = JSON.parse(args.buttonValue) as ButtonValue;
  } catch {
    return { ephemeralText: ":warning: Couldn't parse the click. Try again." };
  }
  if (!parsed.ws || !parsed.wf) {
    return { ephemeralText: ":warning: Click was missing workspace context." };
  }
  const state =
    args.actionId === DIGEST_REACH_OUT_ACTION_ID
      ? "reach_out"
      : args.actionId === DIGEST_SKIP_ACTION_ID
        ? "skip"
        : null;
  if (!state) {
    return { ephemeralText: ":warning: Unknown digest action." };
  }
  try {
    await setReviewState(parsed.ws, parsed.wf, state, {
      setBy: args.slackUserId ? `slack:${args.slackUserId}` : null,
      note: "via digest button",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return { ephemeralText: `:warning: Couldn't save: ${msg}` };
  }
  return {
    ephemeralText:
      state === "reach_out"
        ? ":white_check_mark: Marked _Reach out approved_ in the dashboard."
        : ":black_circle: Marked _Skip_ in the dashboard.",
  };
}
