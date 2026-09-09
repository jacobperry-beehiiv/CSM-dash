/**
 * Parser for #enterprise-bugs-and-feature-requests (C0907JQRXM0) — the
 * channel Juliet's `feature-request-creator` skill posts to on intake,
 * plus manual CSM discussions.
 *
 * Two message shapes we care about:
 *
 * 1. Structured skill-authored posts (like Hayden's SEPA writeup):
 *      Publication ID: <uuid> — <name>
 *      User Email: <mailto:sam@hengeveld.me|sam@hengeveld.me>
 *      Linear ticket: <https://linear.app/beehiiv/issue/REQ-3656/...>
 *    High-signal, machine-parseable.
 *
 * 2. Free-form CSM posts (Chris on Lushe, etc.):
 *      inline `pub_<uuid>` mentions, sometimes a linear.app URL
 *    Best-effort — we extract whatever signals appear.
 *
 * We deliberately require BOTH a customer signal AND ≥1 Linear URL
 * for a message to produce output — matches the user's Sept 9 decision
 * to skip discussion-only posts. Prose-only mentions get dropped.
 */

/** Linear issue URL shape used across beehiiv:
 *    https://linear.app/beehiiv/issue/REQ-3656/grant-premium-when-...
 *  We capture the team-key prefix (usually REQ, sometimes BEE/WEB/POD)
 *  plus the numeric part so the caller can rebuild the identifier
 *  ("REQ-3656") and look up the issue in Linear. Slack wraps URLs in
 *  `<url|display>` in the API payload, so we accept either form. */
const LINEAR_URL_RE =
  /https?:\/\/linear\.app\/beehiiv\/issue\/([A-Z]{2,5}-\d+)(?:[/|>\s"'\]]|$)/gi;

/** `Publication ID: 3947764a-828d-4759-b488-b60e362c33fc — AI Report`
 *  (from the skill template) OR bare `pub_<uuid>` mentions inline
 *  ("- pub_beb94e7c-..."). Both resolve to a publication_id we can
 *  look up in the pub2ws map. */
const PUB_ID_LINE_RE =
  /Publication\s*ID\s*:?\s*(?:`)?(?:pub_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:`)?/i;
const PUB_ID_INLINE_RE =
  /pub_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** `User Email: <mailto:sam@hengeveld.me|sam@hengeveld.me>` — Slack
 *  wraps mailtos in `<mailto:x|x>` in API payloads. Also matches
 *  `User Email: sam@hengeveld.me` (unwrapped) for hand-authored
 *  posts. */
const USER_EMAIL_LINE_RE =
  /User\s*Email\s*:?\s*(?:<mailto:)?([^\s>|<]+@[^\s>|<]+?)(?:\||>|$)/i;

/** Any `<mailto:...>` link, regardless of surrounding label. Kept as
 *  a fallback for messages that don't use the "User Email:" prefix. */
const MAILTO_RE = /<mailto:([^|>]+@[^|>]+?)(?:\||>)/gi;

export interface SlackIntakeParseResult {
  /** Linear ticket identifiers (e.g. "REQ-3656") deduped across the
   *  message. Multiple identifiers in one post are legitimate — a
   *  CSM might link both the request ticket and the delivery
   *  ticket. Each gets its own snapshot row on the resolved
   *  workspace. */
  linear_keys: string[];
  /** Publication IDs (bare UUIDs) extracted from either the
   *  structured `Publication ID:` line or inline `pub_<uuid>` refs.
   *  Deduped. */
  publication_ids: string[];
  /** Email addresses that might be an account owner. Deduped,
   *  lowercased. `User Email:` line wins first, then any `mailto:`
   *  link. */
  owner_emails: string[];
  /** First ~200 chars of the message body, cleaned. Used for the
   *  profile row's hover preview + the admin queue's context
   *  column. */
  body_preview: string;
}

/** Turn a message body into structured signals. Idempotent — parsing
 *  the same message twice yields the same output. Safe on empty
 *  strings; returns everything empty. */
export function parseIntakeMessage(text: string): SlackIntakeParseResult {
  const linearKeys = new Set<string>();
  const pubIds = new Set<string>();
  const emails = new Set<string>();

  if (!text) {
    return {
      linear_keys: [],
      publication_ids: [],
      owner_emails: [],
      body_preview: "",
    };
  }

  // Linear ticket URLs — captureAll via a fresh regex to reset state.
  const linearMatches = text.matchAll(new RegExp(LINEAR_URL_RE.source, "gi"));
  for (const m of linearMatches) {
    if (m[1]) linearKeys.add(m[1].toUpperCase());
  }

  // Structured Publication ID line.
  const pubLine = text.match(PUB_ID_LINE_RE);
  if (pubLine && pubLine[1]) pubIds.add(pubLine[1].toLowerCase());
  // Inline `pub_<uuid>` mentions (Chris-style posts).
  for (const m of text.matchAll(new RegExp(PUB_ID_INLINE_RE.source, "gi"))) {
    if (m[1]) pubIds.add(m[1].toLowerCase());
  }

  // Structured User Email line.
  const emailLine = text.match(USER_EMAIL_LINE_RE);
  if (emailLine && emailLine[1]) emails.add(emailLine[1].trim().toLowerCase());
  // Any other mailto:.
  for (const m of text.matchAll(new RegExp(MAILTO_RE.source, "gi"))) {
    if (m[1]) emails.add(m[1].trim().toLowerCase());
  }

  // Clean the preview: strip Slack `<url|display>` wrappers to the
  // display text, collapse whitespace, trim to 200 chars. Keeps the
  // preview readable in the profile row without linkifying (the row
  // already has a permalink to jump to the full post).
  const cleaned = text
    .replace(/<https?:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<[@#!][A-Z0-9]+(?:\|([^>]+))?>/g, (_full, alt) => alt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const body_preview =
    cleaned.length > 200 ? `${cleaned.slice(0, 197)}…` : cleaned;

  return {
    linear_keys: [...linearKeys],
    publication_ids: [...pubIds],
    owner_emails: [...emails],
    body_preview,
  };
}
