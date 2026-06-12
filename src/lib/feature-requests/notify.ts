import { loadCustomers } from "../data/load-customers";
import { loadSettings } from "../data/settings";
import { resolveSlackNotificationPref } from "../data/settings-types";
import { userKeyFromEmail } from "../personal-todos/identity";
import { applyTodoOps } from "../personal-todos/store";
import { newTodoId, type PersonalTodo } from "../personal-todos/types";
import type { FeatureRequest, FeatureRequestComment } from "./types";

/**
 * Slack DM the feature-request submitter when someone leaves a comment.
 * Best-effort — callers persist the comment even when this returns
 * false (missing token, unmapped Slack user, etc.).
 */

export interface CommentNotifyResult {
  sent: boolean;
  reason?: string;
}

export interface CommentTodoResult {
  added: boolean;
  reason?: string;
}

export interface CommentFollowUpResult {
  slack: CommentNotifyResult;
  todo: CommentTodoResult;
}

function humanizeEmail(email: string): string {
  const prefix = email.split("@")[0] ?? "";
  return prefix
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

async function lookupSlackUserByEmail(email: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  try {
    const params = new URLSearchParams({ email });
    const r = await fetch(
      `https://slack.com/api/users.lookupByEmail?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = (await r.json()) as {
      ok: boolean;
      error?: string;
      user?: { id?: string };
    };
    if (!j.ok) {
      console.warn("[feature-requests] users.lookupByEmail failed", {
        email,
        error: j.error,
      });
      return null;
    }
    return j.user?.id?.trim() ?? null;
  } catch (e) {
    console.warn("[feature-requests] users.lookupByEmail threw", {
      email,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function handleGuessesForSubmitter(
  email: string,
  submitterName: string
): string[] {
  const guesses = new Set<string>();
  const name = submitterName.trim();
  if (name) {
    guesses.add(name.replace(/\s+/g, "_"));
    guesses.add(name.replace(/\s+/g, ""));
  }
  const prefix = email.split("@")[0] ?? "";
  if (prefix) {
    const titled = prefix
      .split(/[._-]/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("_");
    if (titled) guesses.add(titled);
  }
  return [...guesses];
}

function slackIdFromHandleGuesses(
  guesses: Iterable<string>,
  csmUserIds: Record<string, string>
): string | null {
  const entries = Object.entries(csmUserIds);
  for (const guess of guesses) {
    const exact = csmUserIds[guess];
    if (exact) return exact.trim();
    const lc = guess.toLowerCase();
    for (const [handle, id] of entries) {
      if (handle.toLowerCase() === lc && id) return id.trim();
    }
  }
  return null;
}

async function resolveSlackIdForSubmitter(
  email: string,
  submitterName: string,
  csmUserIds: Record<string, string>
): Promise<string | null> {
  const key = userKeyFromEmail(email);
  const fromSlack = await lookupSlackUserByEmail(key);
  if (fromSlack) return fromSlack;

  const fromHandle = slackIdFromHandleGuesses(
    handleGuessesForSubmitter(email, submitterName),
    csmUserIds
  );
  if (fromHandle) return fromHandle;

  const customers = await loadCustomers();
  for (const c of customers) {
    if (
      c.customer_success_manager_email &&
      userKeyFromEmail(c.customer_success_manager_email) === key
    ) {
      const handle = c.customer_success_manager;
      if (handle && csmUserIds[handle]) {
        return csmUserIds[handle].trim();
      }
    }
  }
  return null;
}

async function slackDm(userId: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is not configured");
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: userId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const j = (await res.json()) as { ok: boolean; error?: string };
  if (!j.ok) throw new Error(j.error ?? "chat.postMessage failed");
}

function excerpt(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export async function addSubmitterTodoForComment(args: {
  request: FeatureRequest;
  comment: FeatureRequestComment;
}): Promise<CommentTodoResult> {
  const submitterEmail = args.request.submitter_email?.trim().toLowerCase();
  if (!submitterEmail) {
    return { added: false, reason: "request has no submitter_email" };
  }
  if (args.comment.author_email === submitterEmail) {
    return { added: false, reason: "commenter is the submitter" };
  }

  const dashUrl =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app/";
  const boardUrl = `${dashUrl.replace(/\/$/, "")}/feature-requests`;
  const author =
    args.comment.author_name?.trim() ||
    humanizeEmail(args.comment.author_email);
  const now = new Date().toISOString();
  const todo: PersonalTodo = {
    id: newTodoId(),
    title: `Feature request comment from ${author}`,
    details: [
      args.request.description.trim(),
      "",
      `${author} replied:`,
      args.comment.body.trim(),
      "",
      boardUrl,
    ].join("\n"),
    due_date: null,
    surface_at: null,
    priority: null,
    source: "feature_request",
    source_meta: null,
    completed_at: null,
    // Submitter already gets a Slack DM for the comment — skip the
    // due-date reminder ladder on this tracker row.
    remind_via_slack: false,
    created_at: now,
    updated_at: now,
  };

  try {
    await applyTodoOps(userKeyFromEmail(submitterEmail), [
      { type: "add", todo },
    ]);
    return { added: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("[feature-requests] comment todo failed", {
      submitterEmail,
      error: msg,
    });
    return { added: false, reason: msg };
  }
}

export async function notifySubmitterOfComment(args: {
  request: FeatureRequest;
  comment: FeatureRequestComment;
}): Promise<CommentNotifyResult> {
  const submitterEmail = args.request.submitter_email?.trim().toLowerCase();
  if (!submitterEmail) {
    return { sent: false, reason: "request has no submitter_email" };
  }
  if (args.comment.author_email === submitterEmail) {
    return { sent: false, reason: "commenter is the submitter" };
  }
  if (!process.env.SLACK_BOT_TOKEN) {
    return { sent: false, reason: "SLACK_BOT_TOKEN not configured" };
  }

  const settings = await loadSettings();
  const notifyPref = resolveSlackNotificationPref(
    settings,
    "feature_request_comment"
  );
  if (!notifyPref.enabled) {
    return {
      sent: false,
      reason: "feature_request_comment notifications disabled in settings",
    };
  }
  const slackId = await resolveSlackIdForSubmitter(
    submitterEmail,
    args.request.submitter ?? "",
    settings.slack.csm_user_ids
  );
  if (!slackId) {
    return {
      sent: false,
      reason: `no Slack user for ${submitterEmail} — map them at /settings/slack`,
    };
  }

  const dashUrl =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app/";
  const boardUrl = `${dashUrl.replace(/\/$/, "")}/feature-requests`;
  const author =
    args.comment.author_name?.trim() ||
    humanizeEmail(args.comment.author_email);
  const lines = [
    `<@${slackId}> :speech_balloon: *New comment on your feature request*`,
    "",
    `*Request:* ${excerpt(args.request.description)}`,
    "",
    `*${author}* replied:`,
    `> ${args.comment.body.trim().split("\n").join("\n> ")}`,
    "",
    `<${boardUrl}|Open the feature-requests board ↗>`,
  ];

  try {
    await slackDm(slackId, lines.join("\n"));
    return { sent: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("[feature-requests] comment DM failed", {
      submitterEmail,
      slackId,
      error: msg,
    });
    return { sent: false, reason: msg };
  }
}

/** Slack DM + personal todo for the requester when someone else
 *  comments. Each step is best-effort — a Slack failure doesn't
 *  block the todo, and vice versa. */
export async function followUpSubmitterOnComment(args: {
  request: FeatureRequest;
  comment: FeatureRequestComment;
}): Promise<CommentFollowUpResult> {
  const [slack, todo] = await Promise.all([
    notifySubmitterOfComment(args),
    addSubmitterTodoForComment(args),
  ]);
  return { slack, todo };
}
