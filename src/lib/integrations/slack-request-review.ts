import {
  applyRequestReview,
} from "../data/enterprise-requests";
import type { NeedsReviewReason } from "../data/enterprise-requests-types";
import { updateSlackMessage } from "./slack";

/**
 * Enterprise Request Loop — the weekly review rollup posted to an ops
 * channel, and the button handler behind it.
 *
 * WHAT THE QUEUE MEANS. Linear says these requests are live in the
 * app, but we never found a #devs-shipped release post carrying them.
 * That gap is either a ship we failed to parse or a ticket closed
 * without the code going out. It is NOT a gate: since the confidence
 * check came off the digest's way out (see enterprise-requests-
 * digest.ts), every Linear-live request already reaches its CSM
 * flagged as unmatched. Confirming here records that a human vouched
 * for the ship; dismissing records that it never went out. Both
 * remove the row from the queue. Neither sends anything to a CSM.
 *
 * Get that wrong in the copy and the reviewer thinks they're holding
 * up customer comms — they aren't, and they'll rush the decision.
 *
 * WHY ONE MESSAGE. The alternative shape — a message per pending row
 * so each can carry its own buttons — means N pings and N @-mentions
 * a week at one person. This posts ONE message with a block pair per
 * row, and each click rewrites that same message in place via
 * chat.update. The reviewer is tagged once, in the header.
 *
 * WHY chat.update AND NOT response_url. Slack expires a block_actions
 * `response_url` 30 minutes after the click and caps it at 5 uses.
 * This message is meant to be worked through over days, a row at a
 * time, so the response_url path would break on exactly the usage
 * pattern we're building for. The block_actions payload hands us
 * `channel.id` + `message.ts`, which is all chat.update needs and
 * never goes stale.
 *
 * WHY WE REWRITE THE PAYLOAD'S BLOCKS RATHER THAN RE-DERIVE THEM.
 * Rebuilding the whole message would mean reloading the snapshot AND
 * the customer book on every click, inside Slack's 3-second ACK
 * budget, and would silently re-shuffle the list as rows go live
 * mid-week. Instead we take the blocks Slack just handed back, swap
 * the one row that was decided, and leave every other row's rendering
 * byte-identical. Cheap, and the message stays the snapshot of the
 * week it was posted for.
 */

// ─── Constants ────────────────────────────────────────────────────────

/** Single action_id for both buttons — the decision rides in the
 *  value so the webhook needs only one registration. */
export const REQUEST_REVIEW_ACTION_ID = "enterprise_request_review_decide";

/** block_id prefixes. The resolve path matches on these rather than
 *  parsing button values out of every block, so a row's two blocks
 *  can be found in one pass. */
const SECTION_PREFIX = "errv_s:";
const ACTIONS_PREFIX = "errv_a:";
const HEADER_BLOCK_ID = "errv_header";

/**
 * Slack hard-caps a message at 50 blocks. Each pending row costs 2
 * (section + actions) and the header costs 2, so 20 rows lands at 42
 * with headroom. Anything past that gets a count and a link — a
 * truncated list the reviewer can still act on beats a message Slack
 * rejects outright.
 */
export const MAX_ROLLUP_ROWS = 20;

// ─── Types ────────────────────────────────────────────────────────────

/** JSON-encoded into each button's `value`. Short keys because Slack
 *  caps `value` at 2000 characters and Linear ids are not short. */
export interface RequestReviewActionValue {
  w: string;
  i: string;
  d: "confirmed" | "dismissed";
}

/** One row as the rollup renders it. Mirrors the exceptions page's
 *  ExceptionRow — same predicate, same facts, different surface. */
export interface ReviewRollupRow {
  workspace_id: string;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  url: string;
  /** Company name when we have one, else the workspace name. */
  display_name: string | null;
  csm_handle: string | null;
  /** When Linear says it went live — drives the "waiting Nd" age. */
  live_at: string | null;
  reason: NeedsReviewReason | null;
}

type SlackBlock = Record<string, unknown>;

// ─── Copy helpers ─────────────────────────────────────────────────────

/** Why the row needs a human. Phrased as what to go check, not as the
 *  enum name — the reviewer shouldn't have to decode our taxonomy. */
const REASON_LABEL: Record<NeedsReviewReason, string> = {
  feature_awaiting_changelog: "feature with no changelog post",
  unresolved_work_type: "work type never resolved",
  changelog_fuzzy_match: "changelog matched on wording, not a link",
};

function reasonLabel(reason: NeedsReviewReason | null): string {
  if (!reason) return "no release post found";
  return REASON_LABEL[reason] ?? "no release post found";
}

/** Whole days since `iso`, or null when we can't tell. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** Slack mrkdwn escaping. Request titles are free text written by
 *  CSMs and PMs — an unescaped `<` or `&` breaks the whole block. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render whoever made the call. Dashboard reviews stamp an email;
 * Slack reviews stamp `slack:U…` so we can turn it back into a real
 * mention here instead of printing a raw id at the reviewer.
 */
function renderDecider(by: string): string {
  const trimmed = by.trim();
  if (trimmed.toLowerCase().startsWith("slack:")) {
    return `<@${trimmed.slice(6).toUpperCase()}>`;
  }
  return esc(trimmed);
}

// ─── Block builders ───────────────────────────────────────────────────

/** The identity line for a row. Kept as the section's FIRST line so
 *  the resolve path can lift it back out without re-deriving it. */
function identityLine(row: ReviewRollupRow): string {
  return `*<${row.url}|${esc(row.linear_identifier)}>* — ${esc(row.title)}`;
}

function detailLine(row: ReviewRollupRow): string {
  const bits: string[] = [];
  if (row.display_name) bits.push(esc(row.display_name));
  if (row.csm_handle) bits.push(`CSM ${esc(row.csm_handle.replace(/_/g, " "))}`);
  const age = daysSince(row.live_at);
  if (age !== null) bits.push(`live ${age}d`);
  bits.push(reasonLabel(row.reason));
  return `_${bits.join(" · ")}_`;
}

function rowBlocks(row: ReviewRollupRow): SlackBlock[] {
  const key = `${row.workspace_id}|${row.linear_issue_id}`;
  const val = (d: "confirmed" | "dismissed"): string =>
    JSON.stringify({
      w: row.workspace_id,
      i: row.linear_issue_id,
      d,
    } satisfies RequestReviewActionValue);
  return [
    {
      type: "section",
      block_id: SECTION_PREFIX + key,
      text: {
        type: "mrkdwn",
        text: `${identityLine(row)}\n${detailLine(row)}`,
      },
    },
    {
      type: "actions",
      block_id: ACTIONS_PREFIX + key,
      elements: [
        {
          type: "button",
          action_id: REQUEST_REVIEW_ACTION_ID,
          text: { type: "plain_text", text: "Shipped", emoji: true },
          style: "primary",
          value: val("confirmed"),
        },
        {
          type: "button",
          action_id: REQUEST_REVIEW_ACTION_ID,
          text: { type: "plain_text", text: "Didn't ship", emoji: true },
          value: val("dismissed"),
        },
      ],
    },
  ];
}

function headerBlocks(args: {
  pending: number;
  total: number;
  tagUserIds: string[];
  queueUrl: string;
  oldestDays: number | null;
}): SlackBlock[] {
  const { pending, total, tagUserIds, queueUrl, oldestDays } = args;
  const mentions = tagUserIds
    .map((id) => `<@${id.trim().toUpperCase()}>`)
    .join(" ");
  const truncated = total > pending ? total - pending : 0;
  const lines = [
    `:mag: *Shipped signals waiting on review — ${total}*`,
    mentions
      ? `${mentions} — ${pending} to clear below.`
      : `${pending} to clear below.`,
    "",
    "Linear says these are live in the app, but no #devs-shipped release post backs that up. " +
      "That's either a ship we failed to parse or a ticket closed without the code going out.",
    "",
    "_This isn't holding up customer comms — every Linear-live request already reaches its CSM, " +
      "flagged as unmatched. This is reconciliation: *Shipped* records that a human vouched for it, " +
      "*Didn't ship* records that it never went out. Either way the row leaves the queue._",
  ];
  if (oldestDays !== null && oldestDays > 0) {
    lines.push("", `_Oldest has been waiting ${oldestDays} days._`);
  }
  if (truncated > 0) {
    lines.push(
      "",
      `_${truncated} more not shown (Slack caps a message at 50 blocks) — <${queueUrl}|work the full queue in the dashboard>._`
    );
  }
  return [
    {
      type: "section",
      block_id: HEADER_BLOCK_ID,
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
    { type: "divider" },
  ];
}

/**
 * Compose the whole rollup. `rows` is already trimmed to
 * MAX_ROLLUP_ROWS by the caller; `total` is the untrimmed depth so
 * the header can own up to what it left out.
 */
export function buildReviewRollupBlocks(args: {
  rows: ReviewRollupRow[];
  total: number;
  tagUserIds: string[];
  queueUrl: string;
  oldestDays: number | null;
}): SlackBlock[] {
  return [
    ...headerBlocks({
      pending: args.rows.length,
      total: args.total,
      tagUserIds: args.tagUserIds,
      queueUrl: args.queueUrl,
      oldestDays: args.oldestDays,
    }),
    ...args.rows.flatMap(rowBlocks),
  ];
}

/** Plain-text fallback — what lands in the notification and in
 *  clients that don't render blocks. */
export function reviewRollupFallbackText(total: number): string {
  return `${total} shipped signal${total === 1 ? "" : "s"} waiting on review`;
}

// ─── Resolve-in-place ─────────────────────────────────────────────────

function blockId(b: SlackBlock): string {
  return typeof b.block_id === "string" ? b.block_id : "";
}

/** First line of a section's mrkdwn text, minus any status emoji a
 *  previous resolve prepended, so re-resolving can't stack them. */
function identityFromSection(b: SlackBlock): string {
  const text = (b.text as { text?: string } | undefined)?.text ?? "";
  const first = text.split("\n")[0] ?? "";
  return first.replace(/^(?::white_check_mark:|:x:)\s*/, "");
}

/**
 * Swap one row from "pending + buttons" to a decided line, and
 * refresh the header's remaining count. Every other block is passed
 * through untouched.
 *
 * Returns null when the row's blocks aren't in the message — which
 * means someone already cleared it (from here or from the dashboard)
 * and the message Slack sent us is stale. The caller treats that as a
 * no-op rather than rewriting the message from a stale base.
 */
export function resolveRowInBlocks(args: {
  blocks: SlackBlock[];
  workspaceId: string;
  linearIssueId: string;
  decision: "confirmed" | "dismissed";
  byUserId: string;
}): SlackBlock[] | null {
  const key = `${args.workspaceId}|${args.linearIssueId}`;
  const sectionId = SECTION_PREFIX + key;
  const actionsId = ACTIONS_PREFIX + key;
  const section = args.blocks.find((b) => blockId(b) === sectionId);
  if (!section) return null;

  const emoji =
    args.decision === "confirmed" ? ":white_check_mark:" : ":x:";
  const verdict =
    args.decision === "confirmed" ? "Confirmed shipped" : "Didn't ship";
  const decided: SlackBlock = {
    type: "section",
    block_id: sectionId,
    text: {
      type: "mrkdwn",
      text: `${emoji} ${identityFromSection(section)}`,
    },
  };
  const note: SlackBlock = {
    type: "context",
    block_id: actionsId,
    elements: [
      {
        type: "mrkdwn",
        text: `${verdict} by <@${args.byUserId}>`,
      },
    ],
  };

  const next = args.blocks.map((b) => {
    const id = blockId(b);
    if (id === sectionId) return decided;
    if (id === actionsId) return note;
    return b;
  });

  // Progress goes on the mentions line, NOT the headline count.
  //
  // The headline is the whole queue's depth; this message may only be
  // showing the oldest MAX_ROLLUP_ROWS of it. Rewriting the headline
  // to "1 left" after a click would read as "one left in the queue"
  // when 25 unshown rows are still pending. So the headline stays
  // frozen at what it was posted with, and the line below it tracks
  // progress through THIS message explicitly.
  const remaining = next.filter(
    (b) => blockId(b).startsWith(ACTIONS_PREFIX) && b.type === "actions"
  ).length;
  const shown = next.filter((b) =>
    blockId(b).startsWith(SECTION_PREFIX)
  ).length;
  return next.map((b) => {
    if (blockId(b) !== HEADER_BLOCK_ID) return b;
    const text = (b.text as { text?: string } | undefined)?.text ?? "";
    const lines = text.split("\n");
    // Keep whatever mention prefix the post was built with — it's the
    // only place the tagged user IDs survive, and re-deriving them
    // would mean reloading settings on every click.
    const prefix = (lines[1] ?? "").split(" — ")[0];
    const progress =
      remaining === 0
        ? `all ${shown} cleared :tada:`
        : `${remaining} of ${shown} left below.`;
    lines[1] = prefix.includes("<@")
      ? `${prefix} — ${progress}`
      : progress;
    return { ...b, text: { type: "mrkdwn", text: lines.join("\n") } };
  });
}

/**
 * Button click: write the decision through the SAME path the
 * dashboard's exceptions queue uses, then rewrite the message.
 *
 * The write is deliberately first. If chat.update then fails (rate
 * limit, message deleted, token scope), the decision is still
 * recorded and the dashboard reflects it — the cost is one stale
 * Slack message, not a lost review.
 */
export async function handleRequestReviewAction(args: {
  value: RequestReviewActionValue;
  channel: string | null;
  messageTs: string | null;
  blocks: SlackBlock[];
  userId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { value, channel, messageTs, blocks, userId } = args;
  try {
    const applied = await applyRequestReview({
      workspaceId: value.w,
      linearIssueId: value.i,
      decision: value.d,
      by: `slack:${userId}`,
    });
    if (!applied) {
      console.warn("[request-review] row not in snapshot", {
        workspace_id: value.w,
        linear_issue_id: value.i,
      });
      return { ok: false, error: "row_not_found" };
    }
    if (!channel || !messageTs) {
      return { ok: true };
    }
    const next = resolveRowInBlocks({
      blocks,
      workspaceId: value.w,
      linearIssueId: value.i,
      decision: value.d,
      byUserId: userId,
    });
    if (!next) {
      // Already cleared by someone else. The write above is still
      // correct (applyRequestReview is last-writer-wins on a row that
      // is being set to the same shape), we just have nothing sound
      // to rewrite.
      return { ok: true };
    }
    await updateSlackMessage({
      channel,
      ts: messageTs,
      text: reviewRollupFallbackText(
        next.filter(
          (b) => blockId(b).startsWith(ACTIONS_PREFIX) && b.type === "actions"
        ).length
      ),
      blocks: next,
    });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn("[request-review] decision failed", {
      workspace_id: value.w,
      linear_issue_id: value.i,
      decision: value.d,
      error,
    });
    return { ok: false, error };
  }
}
