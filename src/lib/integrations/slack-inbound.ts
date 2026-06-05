import crypto from "node:crypto";

/**
 * Inbound-from-Slack utilities — signature verification, payload
 * parsing, and bot-user-id caching. Until this file existed the dash
 * was outbound-only; the personal-todos webhook is the first surface
 * that *receives* from Slack, so the discipline around verification
 * and replay protection lives here in one place.
 *
 * Verification rules per the Slack docs:
 *   1. Reconstruct `v0:${timestamp}:${rawBody}`.
 *   2. HMAC-SHA256 with the app's signing secret.
 *   3. Compare against the `X-Slack-Signature` header (constant-time).
 *   4. Reject if the timestamp is more than 5 minutes stale (replay
 *      protection — Slack rotates signatures per request, but rejecting
 *      old timestamps is the second line of defense).
 *
 * Any failure returns false; callers respond 401 without logging the
 * signature itself.
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export interface VerifyArgs {
  /** The raw, exact bytes Slack sent. Verifying against the parsed
   *  JSON or form data won't match — any whitespace/key-order change
   *  flips the HMAC. The webhook reads the body twice (once for
   *  verification, once for parsing) so the framework gives us the
   *  unmodified string. */
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  signingSecret: string;
}

/** Return true iff the signature matches and the timestamp is fresh.
 *  Never throws — invalid inputs (missing headers, malformed sig)
 *  resolve to false so callers can `if (!verify) return 401`. */
export function verifySlackSignature(args: VerifyArgs): boolean {
  const { rawBody, signatureHeader, timestampHeader, signingSecret } = args;
  if (!signatureHeader || !timestampHeader || !signingSecret) return false;

  const tsNum = Number(timestampHeader);
  if (!Number.isFinite(tsNum)) return false;
  // Slack timestamps are in seconds; convert to ms for the freshness check.
  const ageMs = Date.now() - tsNum * 1000;
  if (Math.abs(ageMs) > FIVE_MINUTES_MS) return false;

  const base = `v0:${timestampHeader}:${rawBody}`;
  const computed =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const given = signatureHeader;
  // Length mismatch → bail before timingSafeEqual (which throws on
  // mismatched buffer lengths).
  if (computed.length !== given.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(given));
  } catch {
    return false;
  }
}

/** Slack URL-verification handshake — sent once when the admin saves
 *  the event-subscription request URL in the Slack app config. We just
 *  echo the challenge back as JSON. */
export interface UrlVerification {
  type: "url_verification";
  challenge: string;
}

/** Outer envelope for events_api callbacks (DMs, reactions, etc.). */
export interface SlackEventEnvelope {
  type: "event_callback";
  event: SlackEvent;
  team_id?: string;
  event_id?: string;
  event_time?: number;
}

/** Slim discriminated union covering the events the dash listens to.
 *  Slack sends way more fields than we use; we type only what we
 *  consume so changes in unrelated fields don't break compilation. */
export type SlackEvent =
  | {
      type: "message";
      channel: string;
      channel_type?: string;
      user?: string;
      bot_id?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
      subtype?: string;
    }
  | {
      type: "reaction_added";
      user: string;
      reaction: string;
      item: { type: string; channel: string; ts: string };
      item_user?: string;
      event_ts?: string;
    };

/** Slash-command payload — Slack posts these as form-urlencoded, not
 *  JSON. Decoded into an object by the webhook before passing here.
 *  Fields we don't use are omitted from the type for clarity. */
export interface SlackSlashCommand {
  command: string;
  text: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  response_url: string;
  trigger_id: string;
}

// ─── Bot-user-id cache ────────────────────────────────────────────────
// Slack's `message.im` event fires both when a human DMs the bot AND
// when the bot DMs back. We need to drop the bot's own messages or
// every outbound DM becomes a new todo. The auth.test API resolves the
// bot's user_id; cache it forever (module-scoped) — it never changes
// without re-installing the app, which restarts the isolate anyway.

let botUserIdCache: string | null = null;
let botUserIdPromise: Promise<string | null> | null = null;

export async function getBotUserId(): Promise<string | null> {
  if (botUserIdCache) return botUserIdCache;
  if (botUserIdPromise) return botUserIdPromise;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  botUserIdPromise = fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
    .then(async (r) => {
      const j = (await r.json()) as { ok: boolean; user_id?: string };
      if (j.ok && j.user_id) {
        botUserIdCache = j.user_id;
        return j.user_id;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      botUserIdPromise = null;
    });
  return botUserIdPromise;
}

// ─── Slash-command parser ─────────────────────────────────────────────
// `/todo <directives + free text>` — supports interleaved tokens:
//
//   /todo Review Foo Co quarterly report
//   /todo on:2026-07-01 Send Q3 check-in
//   /todo due:2026-06-15 !high Follow up on past-due
//   /todo !medium Reply to Mac re onboarding template
//
// Tokens recognized:
//   on:YYYY-MM-DD   → surface_at (scheduled future-dated)
//   due:YYYY-MM-DD  → due_date (drives reminder ladder)
//   !high|!medium|!low → priority
//
// Anything else is joined as the title.

export interface ParsedSlashTodo {
  title: string;
  surface_at: string | null;
  due_date: string | null;
  priority: "high" | "medium" | "low" | null;
  /** True when the user added `!silent` to the inline command,
   *  opting out of the 4-stage Slack reminder ladder. Defaults to
   *  `true` (= reminders enabled) when omitted; the type is nullable
   *  so the caller can distinguish "unset" (use default) from
   *  "explicitly off." */
  remind_via_slack: boolean | null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSlashTodoText(text: string): ParsedSlashTodo {
  const result: ParsedSlashTodo = {
    title: "",
    surface_at: null,
    due_date: null,
    priority: null,
    remind_via_slack: null,
  };
  const remaining: string[] = [];
  // Use a permissive split so emojis / unicode don't choke.
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith("on:")) {
      const value = token.slice(3);
      if (YMD_RE.test(value)) {
        result.surface_at = value;
        continue;
      }
    } else if (token.startsWith("due:")) {
      const value = token.slice(4);
      if (YMD_RE.test(value)) {
        result.due_date = value;
        continue;
      }
    } else if (token === "!high" || token === "!medium" || token === "!low") {
      result.priority = token.slice(1) as "high" | "medium" | "low";
      continue;
    } else if (token === "!silent" || token === "!quiet") {
      // Suppress the daily Slack reminder ladder for this row.
      result.remind_via_slack = false;
      continue;
    }
    remaining.push(token);
  }
  result.title = remaining.join(" ").trim();
  return result;
}
