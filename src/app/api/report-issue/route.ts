import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadSettings } from "@/lib/data/settings";
import {
  findSlackChannel,
  ISSUE_REPORTS_CHANNEL_ID,
} from "@/lib/data/settings-types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Receives a user-submitted issue report and forwards it to Slack.
 *
 *   POST  /api/report-issue
 *   body  { message, url, user_agent?, screenshot_base64?, screenshot_mime? }
 *
 * Auth: session-only (must be a signed-in CSM). Issue reports come
 * from the floating button rendered in the global layout; there's no
 * legitimate scripted caller.
 *
 * Destination channel comes from settings.slack.channels[] where
 * id = "issue_reports". When that channel isn't configured we return
 * a 503 with a clear admin-facing fix.
 *
 * Screenshot handling: Slack's modern upload flow is a 3-step dance
 * (getUploadURLExternal → PUT bytes → completeUploadExternal). The
 * completeUploadExternal call accepts an `initial_comment` so the
 * report's text body shows up alongside the image as one Slack item.
 * When no screenshot is attached we just chat.postMessage the text.
 *
 * Required Slack bot scopes: `chat:write`, `files:write`. If
 * `files:write` is missing the screenshot upload fails gracefully —
 * we fall back to a text-only post with a note in the message.
 */

interface Body {
  message?: string;
  url?: string;
  user_agent?: string;
  /** Base64-encoded image (without the data: prefix). Optional. */
  screenshot_base64?: string;
  /** e.g. "image/png". Optional. */
  screenshot_mime?: string;
}

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: "Sign in to report an issue." },
      { status: 401 }
    );
  }
  if (!SLACK_BOT_TOKEN) {
    return NextResponse.json(
      {
        error:
          "SLACK_BOT_TOKEN env var isn't set on the server. Reach out to Jacob.",
      },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json(
      { error: "Tell me what's going on first — the message field is empty." },
      { status: 400 }
    );
  }
  if (message.length > 5000) {
    return NextResponse.json(
      { error: "Message is too long (max 5000 characters)." },
      { status: 400 }
    );
  }

  const settings = await loadSettings();
  const cfg = findSlackChannel(settings.slack, ISSUE_REPORTS_CHANNEL_ID);
  if (!cfg?.channel_id) {
    return NextResponse.json(
      {
        error:
          "The issue-reports Slack channel isn't configured yet. An admin can set it up at /settings/slack (channel id `issue_reports`).",
      },
      { status: 503 }
    );
  }

  // Compose the text body. Goes either as initial_comment alongside
  // the screenshot upload, or as the chat.postMessage text on its own.
  const lines = [
    `:bug: *Issue report from <mailto:${session.user.email}|${session.user.email}>*`,
    "",
    message,
    "",
  ];
  if (body.url) lines.push(`*Page:* ${body.url}`);
  if (body.user_agent)
    lines.push(`*Browser:* \`${truncate(body.user_agent, 200)}\``);
  let composed = lines.join("\n");

  let uploadWarning: string | null = null;
  let posted = false;

  if (body.screenshot_base64 && body.screenshot_mime) {
    try {
      await uploadScreenshot({
        channelId: cfg.channel_id,
        base64: body.screenshot_base64,
        mime: body.screenshot_mime,
        initialComment: composed,
        reporterEmail: session.user.email,
      });
      posted = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.error("[report-issue] screenshot upload failed:", msg);
      uploadWarning = msg;
      // Annotate the text so the slack message records the upload
      // failure rather than silently dropping the screenshot.
      composed += `\n\n_(screenshot attachment failed: ${msg})_`;
    }
  }

  if (!posted) {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: cfg.channel_id,
        text: composed,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const j = (await r.json()) as { ok: boolean; error?: string };
    if (!j.ok) {
      return NextResponse.json(
        { error: `Slack post failed: ${j.error}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    screenshot_uploaded: posted && !uploadWarning,
    upload_warning: uploadWarning,
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

interface UploadInput {
  channelId: string;
  base64: string;
  mime: string;
  initialComment: string;
  reporterEmail: string;
}

/**
 * Slack's modern file-upload flow. Three calls, in order:
 *
 *   1. files.getUploadURLExternal — returns a one-shot upload URL +
 *      a file_id we'll use to finalize.
 *   2. POST the raw bytes to that upload URL (NOT to slack.com — it's
 *      a redirected files.slack.com-or-similar host).
 *   3. files.completeUploadExternal — finalize, attach to the
 *      destination channel, set an initial_comment so the issue
 *      message lands alongside the screenshot.
 *
 * Each failure mode bubbles up with a specific Slack error code so
 * the POST handler can log it and fall back to text-only.
 */
async function uploadScreenshot(input: UploadInput): Promise<void> {
  const buffer = Buffer.from(input.base64, "base64");
  const ext = mimeToExt(input.mime);
  const filename = `issue-${Date.now()}-${input.reporterEmail.replace(
    /[^a-z0-9]+/gi,
    "_"
  )}.${ext}`;

  // Step 1
  const r1 = await fetch(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename,
        length: String(buffer.length),
      }),
    }
  );
  const j1 = (await r1.json()) as {
    ok: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  };
  if (!j1.ok || !j1.upload_url || !j1.file_id) {
    throw new Error(`getUploadURLExternal: ${j1.error ?? "unknown"}`);
  }

  // Step 2 — POST the bytes. Slack documents this as a multipart
  // form-data POST with the file under field name "file".
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: input.mime }),
    filename
  );
  const r2 = await fetch(j1.upload_url, {
    method: "POST",
    body: fd,
  });
  if (!r2.ok) {
    throw new Error(`upload PUT: HTTP ${r2.status}`);
  }

  // Step 3 — Slack's files.completeUploadExternal is far happier with
  // form-encoded params than a JSON body: the `files` array must be a
  // JSON-encoded STRING, not a real array. Sending it as a real array
  // via Content-Type: application/json reliably trips `invalid_arguments`
  // even though the docs imply both encodings work. The Slack Node SDK
  // does exactly this under the hood.
  const r3 = await fetch(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        files: JSON.stringify([{ id: j1.file_id, title: filename }]),
        channel_id: input.channelId,
        initial_comment: input.initialComment,
      }),
    }
  );
  const j3 = (await r3.json()) as {
    ok: boolean;
    error?: string;
    response_metadata?: { messages?: string[] };
  };
  if (!j3.ok) {
    // Slack returns the offending field name in response_metadata.messages
    // for invalid_arguments responses — surface it so the next failure
    // points straight at the bad input.
    const detail = j3.response_metadata?.messages?.join("; ") ?? "";
    throw new Error(
      `completeUploadExternal: ${j3.error ?? "unknown"}${
        detail ? ` (${detail})` : ""
      }`
    );
  }
}

function mimeToExt(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}
