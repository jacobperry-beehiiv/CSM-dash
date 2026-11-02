import { loadCustomers } from "../data/load-customers";
import {
  applyRequestReviewsBatch,
  loadEnterpriseRequestsSnapshot,
} from "../data/enterprise-requests";
import {
  liveAt,
  needsReconciling,
} from "../data/enterprise-requests-types";
import type {
  EnterpriseRequestRow,
  NeedsReviewReason,
} from "../data/enterprise-requests-types";
import { updateSlackMessage } from "./slack";
import {
  openSlackView,
  updateSlackView,
  type ViewSubmitHandler,
} from "./slack-views";

/**
 * Enterprise Request Loop — the weekly review prompt and its modal.
 *
 * WHAT THE QUEUE MEANS. Linear says these requests are live in the
 * app, but we never found a #devs-shipped release post carrying them.
 * That gap is either a ship we failed to parse or a ticket closed
 * without the code going out. It is NOT a gate: since the confidence
 * check came off the digest's way out (see enterprise-requests-
 * digest.ts), every Linear-live request already reaches its CSM
 * flagged as unmatched. Confirming records that a human vouched for
 * the ship; dismissing records that it never went out. Both remove
 * the row from the queue. Neither sends anything to a CSM.
 *
 * Get that wrong in the copy and the reviewer thinks they're holding
 * up customer comms — they aren't, and they'll rush the decision.
 *
 * SHAPE: TWO BLOCKS IN THE CHANNEL, THE QUEUE IN A MODAL.
 *
 * The channel gets a count, one @-mention and a button — that's it,
 * however deep the queue is. Everything else lives in a modal the
 * reviewer opens. Two shapes were rejected on the way here:
 *
 *   - One message per pending row, each with its own buttons. N
 *     pings and N mentions a week at one person.
 *   - One message listing every row with per-row buttons. One ping,
 *     but a 40-block wall in a shared channel that everyone else
 *     scrolls past every Monday.
 *
 * THE MODAL IS RESUMABLE, NOT ALL-OR-NOTHING. Every row defaults to
 * no selection, and submit writes only the rows actually touched.
 * Close it half-done and nothing is lost: the rows still pending are
 * the rows the next open will show. That matters at 27 rows — a
 * modal that discards partial work on close is a modal nobody
 * finishes.
 *
 * WHY views.open IS A SKELETON FIRST. Slack gives a trigger_id three
 * seconds to live. Building the real modal needs the request
 * snapshot AND the customer book, and on a cold isolate decrypting
 * the 2.9MB book alone can eat most of that budget. So we open an
 * empty "Loading…" view immediately — well inside the window, and
 * it tells the reviewer the click registered — then fill it with
 * views.update, which takes a view_id and has no such deadline.
 */

// ─── Constants ────────────────────────────────────────────────────────

/** Button on the weekly channel prompt. */
export const REVIEW_OPEN_ACTION_ID = "enterprise_request_review_open";

/** callback_id on the modal. Registered in dispatchViewSubmission. */
export const REVIEW_MODAL_CALLBACK_ID = "enterprise_request_review_modal";

/** action_id on every row's radio group. The block_id carries which
 *  row it is; the action_id is the same throughout. */
const ROW_ACTION_ID = "verdict";

/** block_id prefix for a row's radio input. */
const ROW_BLOCK_PREFIX = "rv:";

/** action_id on the plain link button next to Review. Slack still
 *  POSTs a block_actions event for url buttons, so the webhook needs
 *  to know this one exists and is a no-op. */
export const REVIEW_DASHBOARD_ACTION_ID = "errv_open_dashboard";

/** Where the full queue lives. One definition so the prompt, the
 *  modal and the post-submit refresh can't point at different URLs. */
export function reviewQueueUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_DASHBOARD_URL?.replace(/\/$/, "") ??
    "https://csm-dash.vercel.app";
  return `${base}/settings/enterprise-requests/exceptions`;
}

/**
 * Slack caps a modal at 100 blocks. A row costs 2 (section + radio
 * input) and the header costs 2, so 49 is the ceiling; 40 leaves
 * headroom and is already a long scroll. The overflow is reachable
 * next week, or in the dashboard — the modal says so.
 */
export const MAX_MODAL_ROWS = 40;

// ─── Types ────────────────────────────────────────────────────────────

export interface ReviewRow {
  workspace_id: string;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  url: string;
  /** Company name when we have one, else the workspace name. */
  display_name: string | null;
  csm_handle: string | null;
  live_at: string | null;
  reason: NeedsReviewReason | null;
}

/** Round-tripped through the modal's private_metadata so the submit
 *  handler can refresh the message the reviewer opened it from. */
interface ReviewModalMeta {
  c: string | null;
  t: string | null;
}

type SlackBlock = Record<string, unknown>;

// ─── Copy helpers ─────────────────────────────────────────────────────

const REASON_LABEL: Record<NeedsReviewReason, string> = {
  feature_awaiting_changelog: "feature with no changelog post",
  unresolved_work_type: "work type never resolved",
  changelog_fuzzy_match: "changelog matched on wording, not a link",
};

function reasonLabel(reason: NeedsReviewReason | null): string {
  if (!reason) return "no release post found";
  return REASON_LABEL[reason] ?? "no release post found";
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** Request titles are free text written by CSMs and PMs — an
 *  unescaped `<` or `&` breaks the whole block. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Row collection ───────────────────────────────────────────────────

/**
 * Every row still needing reconciliation, oldest first.
 *
 * Oldest first because that's the order that survives truncation:
 * the rows that have been sitting longest are the ones most likely
 * to have gone stale, and the ones a reviewer most needs to see.
 */
export async function loadPendingReviewRows(): Promise<ReviewRow[]> {
  const [snapshot, customers] = await Promise.all([
    loadEnterpriseRequestsSnapshot(),
    loadCustomers(),
  ]);
  const meta = new Map<
    string,
    { display_name: string | null; csm_handle: string | null }
  >();
  for (const c of customers) {
    if (!c.workspace_id) continue;
    meta.set(c.workspace_id, {
      display_name: c.company_name ?? c.workspace_name ?? null,
      csm_handle: c.customer_success_manager ?? null,
    });
  }
  const rows: ReviewRow[] = [];
  for (const [workspaceId, bucket] of Object.entries(snapshot.rows)) {
    for (const row of Object.values(bucket) as EnterpriseRequestRow[]) {
      if (!needsReconciling(row)) continue;
      const m = meta.get(workspaceId);
      rows.push({
        workspace_id: workspaceId,
        linear_issue_id: row.linear_issue_id,
        linear_identifier: row.linear_identifier,
        title: row.title,
        url: row.url,
        display_name: m?.display_name ?? null,
        csm_handle: m?.csm_handle ?? null,
        live_at: liveAt(row),
        reason: row.needs_review_reason ?? null,
      });
    }
  }
  rows.sort((a, b) => (a.live_at ?? "").localeCompare(b.live_at ?? ""));
  return rows;
}

// ─── The channel prompt ───────────────────────────────────────────────

/**
 * The weekly message. Two blocks regardless of queue depth — the
 * whole point of the modal is that the channel stays quiet.
 *
 * `footer` carries the "last cleared by…" line after a submit, so
 * the channel shows the queue moving without a second message.
 */
export function buildReviewPromptBlocks(args: {
  total: number;
  tagUserIds: string[];
  oldestDays: number | null;
  queueUrl: string;
  footer?: string | null;
}): SlackBlock[] {
  const { total, tagUserIds, oldestDays, queueUrl, footer } = args;
  const mentions = tagUserIds
    .map((id) => `<@${id.trim().toUpperCase()}>`)
    .join(" ");
  const lines = [
    `:mag: *${total} shipped signal${total === 1 ? "" : "s"} waiting on review*`,
  ];
  lines.push(
    (mentions ? `${mentions} — ` : "") +
      "Linear says these are live in the app, but no #devs-shipped post " +
      "backs that up. Reconciliation only — CSMs have already been told, " +
      "flagged as unmatched."
  );
  if (oldestDays !== null && oldestDays > 0) {
    lines.push(`_Oldest has been waiting ${oldestDays} days._`);
  }
  if (footer) lines.push(`_${footer}_`);

  const blocks: SlackBlock[] = [
    {
      type: "section",
      block_id: "errv_prompt",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
  ];
  // No rows left — drop the button rather than open an empty modal.
  if (total > 0) {
    blocks.push({
      type: "actions",
      block_id: "errv_prompt_actions",
      elements: [
        {
          type: "button",
          action_id: REVIEW_OPEN_ACTION_ID,
          text: {
            type: "plain_text",
            text: `Review ${total} ticket${total === 1 ? "" : "s"}`,
            emoji: true,
          },
          style: "primary",
          value: "open",
        },
        {
          type: "button",
          action_id: REVIEW_DASHBOARD_ACTION_ID,
          text: { type: "plain_text", text: "Open dashboard", emoji: true },
          url: queueUrl,
        },
      ],
    });
  }
  return blocks;
}

export function reviewPromptFallbackText(total: number): string {
  return `${total} shipped signal${total === 1 ? "" : "s"} waiting on review`;
}

// ─── The modal ────────────────────────────────────────────────────────

function rowBlocks(row: ReviewRow): SlackBlock[] {
  const bits: string[] = [];
  if (row.display_name) bits.push(esc(row.display_name));
  if (row.csm_handle) bits.push(`CSM ${esc(row.csm_handle.replace(/_/g, " "))}`);
  const age = daysSince(row.live_at);
  if (age !== null) bits.push(`live ${age}d`);
  bits.push(reasonLabel(row.reason));

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*<${row.url}|${esc(row.linear_identifier)}>* — ${esc(row.title)}\n` +
          `_${bits.join(" · ")}_`,
      },
    },
    {
      type: "input",
      // Unselected is a real answer here: "not deciding this one
      // today". Without optional:true Slack refuses the submit until
      // every row is answered, which is what makes a 40-row modal
      // something you abandon rather than chip away at.
      optional: true,
      block_id: `${ROW_BLOCK_PREFIX}${row.workspace_id}|${row.linear_issue_id}`,
      // The ticket key, not a blank. Slack requires a label on an
      // input block and rejects the whole view with `invalid_blocks`
      // if it doesn't like what it gets — a whitespace-only label is
      // the kind of thing that works until it doesn't, and it would
      // take the entire modal down with it. Repeating the key here
      // also keeps the radios anchored to a ticket once the modal is
      // long enough to scroll.
      label: {
        type: "plain_text",
        text: row.linear_identifier || "Verdict",
        emoji: false,
      },
      element: {
        type: "radio_buttons",
        action_id: ROW_ACTION_ID,
        options: [
          {
            text: { type: "plain_text", text: "Shipped", emoji: true },
            value: "confirmed",
          },
          {
            text: { type: "plain_text", text: "Didn't ship", emoji: true },
            value: "dismissed",
          },
        ],
      },
    },
  ];
}

/** The real modal, once the data is loaded. */
export function buildReviewModalView(args: {
  rows: ReviewRow[];
  total: number;
  meta: ReviewModalMeta;
  queueUrl: string;
}): Record<string, unknown> {
  const { rows, total, meta, queueUrl } = args;
  const truncated = total > rows.length ? total - rows.length : 0;
  const intro = [
    "Pick a verdict for the ones you're sure about and leave the rest blank — " +
      "only what you select gets saved, so you can close this and pick up where " +
      "you left off.",
    "",
    "*Shipped* — it really went out, we just couldn't find the release post." +
      "\n*Didn't ship* — the ticket closed without the code going out.",
  ];
  if (truncated > 0) {
    intro.push(
      "",
      `_Showing the ${rows.length} oldest of ${total}. The rest are in ` +
        `<${queueUrl}|the dashboard>, or here again next week._`
    );
  }
  return {
    type: "modal",
    callback_id: REVIEW_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Shipped signals", emoji: false },
    submit: { type: "plain_text", text: "Save verdicts", emoji: false },
    close: { type: "plain_text", text: "Cancel", emoji: false },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: intro.join("\n") } },
      { type: "divider" },
      ...rows.flatMap(rowBlocks),
    ],
  };
}

/** Shown for the few hundred ms between the click and the data. */
function loadingView(meta: ReviewModalMeta): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: REVIEW_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Shipped signals", emoji: false },
    close: { type: "plain_text", text: "Cancel", emoji: false },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":hourglass_flowing_sand: Loading the queue…" },
      },
    ],
  };
}

function emptyView(meta: ReviewModalMeta): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: REVIEW_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Shipped signals", emoji: false },
    close: { type: "plain_text", text: "Done", emoji: false },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            ":white_check_mark: *Nothing left to reconcile.*\nEvery Linear-live " +
            "request either matches a release post or has a verdict on it.",
        },
      },
    ],
  };
}

/**
 * Button click → modal. Skeleton first (see the file header on the
 * trigger_id deadline), then the real content via views.update.
 */
export async function openReviewModal(args: {
  triggerId: string;
  channel: string | null;
  messageTs: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const queueUrl = reviewQueueUrl();
  const meta: ReviewModalMeta = { c: args.channel, t: args.messageTs };
  const opened = await openSlackView(args.triggerId, loadingView(meta));
  if (!opened.ok) return { ok: false, error: opened.error };
  const viewId = opened.view?.id;
  if (!viewId) {
    return { ok: false, error: "views.open returned no view id" };
  }
  try {
    const rows = await loadPendingReviewRows();
    const view =
      rows.length === 0
        ? emptyView(meta)
        : buildReviewModalView({
            rows: rows.slice(0, MAX_MODAL_ROWS),
            total: rows.length,
            meta,
            queueUrl,
          });
    return await updateSlackView(viewId, view);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn("[request-review] couldn't fill the modal", { error });
    await updateSlackView(viewId, {
      type: "modal",
      callback_id: REVIEW_MODAL_CALLBACK_ID,
      title: { type: "plain_text", text: "Shipped signals", emoji: false },
      close: { type: "plain_text", text: "Close", emoji: false },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              ":warning: Couldn't load the queue. Try again, or work it in " +
              `<${queueUrl}|the dashboard>.`,
          },
        },
      ],
    });
    return { ok: false, error };
  }
}

// ─── Submit ───────────────────────────────────────────────────────────

/**
 * Save the verdicts, then refresh the channel prompt so the count
 * reflects the work without posting a second message.
 *
 * Rows left blank are skipped, not defaulted — see the modal's
 * `optional: true`.
 */
export const reviewModalHandler: ViewSubmitHandler = async ({
  payload,
  userKey,
}) => {
  const decisions: Array<{
    workspaceId: string;
    linearIssueId: string;
    decision: "confirmed" | "dismissed";
  }> = [];
  for (const [blockId, actions] of Object.entries(
    payload.view.state?.values ?? {}
  )) {
    if (!blockId.startsWith(ROW_BLOCK_PREFIX)) continue;
    const picked = actions?.[ROW_ACTION_ID];
    if (!picked || picked.type !== "radio_buttons") continue;
    const value = picked.selected_option?.value;
    if (value !== "confirmed" && value !== "dismissed") continue;
    const [workspaceId, linearIssueId] = blockId
      .slice(ROW_BLOCK_PREFIX.length)
      .split("|");
    if (!workspaceId || !linearIssueId) continue;
    decisions.push({ workspaceId, linearIssueId, decision: value });
  }

  const slackUser = payload.user.id;
  if (decisions.length === 0) {
    // Nothing picked. Closing silently is right — the reviewer
    // opened it, decided nothing, and the queue is unchanged.
    return {};
  }

  let meta: ReviewModalMeta = { c: null, t: null };
  try {
    meta = JSON.parse(payload.view.private_metadata ?? "{}") as ReviewModalMeta;
  } catch {
    /* refresh is best-effort; the writes below are what matter */
  }

  try {
    const { applied, missing } = await applyRequestReviewsBatch({
      decisions,
      by: userKey || `slack:${slackUser}`,
    });
    const confirmed = applied.filter(
      (r) => r.review?.decision === "confirmed"
    ).length;
    const dismissed = applied.length - confirmed;
    if (missing.length > 0) {
      console.warn("[request-review] rows vanished before submit", { missing });
    }
    await refreshPromptMessage({
      channel: meta.c,
      messageTs: meta.t,
      footer:
        `Last cleared by <@${slackUser}>: ${confirmed} shipped, ` +
        `${dismissed} didn't.`,
    });
  } catch (e) {
    console.error("[request-review] batch submit failed", e);
    // Surfacing the failure on the first row's block keeps the modal
    // open with the reviewer's selections intact, so a transient KV
    // error doesn't cost them the whole screen of work.
    const firstBlock = `${ROW_BLOCK_PREFIX}${decisions[0].workspaceId}|${decisions[0].linearIssueId}`;
    return {
      response_action: "errors",
      errors: {
        [firstBlock]: "Couldn't save — nothing was recorded. Try again.",
      } as Record<string, string>,
    };
  }
  return {};
};

/**
 * Recount the queue and rewrite the weekly prompt in place.
 *
 * Best-effort: a failure here means a stale count in Slack, never a
 * lost verdict — the writes already landed.
 */
async function refreshPromptMessage(args: {
  channel: string | null;
  messageTs: string | null;
  footer: string;
}): Promise<void> {
  if (!args.channel || !args.messageTs) return;
  try {
    const [{ loadSettings }, { resolveSlackNotificationPref }] =
      await Promise.all([
        import("../data/settings"),
        import("../data/settings-types"),
      ]);
    const settings = await loadSettings();
    const pref = resolveSlackNotificationPref(
      settings,
      "enterprise_requests_review_queue"
    );
    const rows = await loadPendingReviewRows();
    const oldest = rows[0]?.live_at ?? null;
    await updateSlackMessage({
      channel: args.channel,
      ts: args.messageTs,
      text: reviewPromptFallbackText(rows.length),
      blocks: buildReviewPromptBlocks({
        total: rows.length,
        tagUserIds: pref.tag_user_ids ?? [],
        oldestDays: daysSince(oldest),
        queueUrl: reviewQueueUrl(),
        footer: args.footer,
      }),
    });
  } catch (e) {
    console.warn("[request-review] prompt refresh failed", {
      error: e instanceof Error ? e.message : e,
    });
  }
}
