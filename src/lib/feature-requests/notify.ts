import { loadCustomers } from "../data/load-customers";
import { loadSettings } from "../data/settings";
import { userKeyFromEmail } from "../personal-todos/identity";
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

async function resolveSlackIdForEmail(
  email: string,
  csmUserIds: Record<string, string>
): Promise<string | null> {
  const key = userKeyFromEmail(email);
  const fromSlack = await lookupSlackUserByEmail(key);
  if (fromSlack) return fromSlack;

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
  const slackId = await resolveSlackIdForEmail(
    submitterEmail,
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
    ":speech_balloon: *New comment on your feature request*",
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
