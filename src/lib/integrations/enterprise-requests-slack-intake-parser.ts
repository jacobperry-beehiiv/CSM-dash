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

/** Structured `Publication ID` line — the skill posts this on its
 *  own line, with the label wrapped in literal backticks (Slack
 *  renders backticks as inline <code>) and the value on the LINE
 *  BELOW, followed by an em-dash + publication name:
 *
 *      `Publication ID`
 *      3947764a-828d-4759-b488-b60e362c33fc — AI Report
 *
 *  Also tolerates: no backticks (hand-authored), colon-form
 *  ("Publication ID:"), and either bare UUID or `pub_<uuid>` form.
 *  `\s*` matches the newline between label and value in JS regex,
 *  and the `[*_`]?` bookends catch backtick / bold / italic
 *  variants a future skill iteration might use. */
const PUB_ID_LINE_RE =
  /[*_`]?Publication\s*ID[*_`]?\s*:?\s*[*_`]?(?:pub_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[*_`]?/i;
const PUB_ID_INLINE_RE =
  /pub_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Structured `User Email` line from the skill:
 *
 *      `User Email`
 *      <mailto:sam@hengeveld.me|sam@hengeveld.me>
 *
 *  Slack wraps mailtos as `<mailto:x|x>` in API payloads. Also
 *  tolerates unwrapped `User Email: sam@…` for hand-authored posts
 *  and bold/italic label variants. */
const USER_EMAIL_LINE_RE =
  /[*_`]?User\s*Email[*_`]?\s*:?\s*(?:<mailto:)?([^\s>|<]+@[^\s>|<]+?)(?:\||>|$)/i;

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
/**
 * Normalize a body before pattern-matching.
 *
 * Every pattern here was written against Slack message text. The same
 * structured block arriving from a LINEAR ISSUE DESCRIPTION carries
 * two encodings Slack never produces, and both silently defeated
 * extraction — the nightly scan reported 228 descriptions parsed and
 * 228 unresolvable, i.e. a 100% miss rate on the description path,
 * while all 21 comment-sourced matches resolved fine.
 *
 *   1. Blockquote prefixes. Linear renders the skill's block as a
 *      quote, so the value sits on the next line behind "> ". The
 *      label patterns allow only `\s*` between label and value, and
 *      ">" is not whitespace, so `Publication ID` never matched.
 *
 *   2. URL-encoded pipes. Linear writes a mailto as a markdown link —
 *      [mailto:a@x|a@x](<mailto:a@x%7Ca@x>) — and MAILTO_RE treats
 *      "|" as the separator between address and display text. With
 *      the pipe encoded as %7C it isn't seen, so the whole
 *      "a@x%7Ca@x" was captured as one address.
 *
 * Verified against BEE-24879 (Daily Drop), which shipped a public
 * subscription-export API and never reached the tracker: identical
 * text parsed correctly in Slack shape and yielded nothing usable in
 * Linear shape.
 */
/** Strip wrapper punctuation off a captured address.
 *
 *  A markdown mailto link opens with "[mailto:" — once the encoded
 *  pipe is restored the capture terminates in the right place, but
 *  the leading bracket and scheme ride along, yielding
 *  "[mailto:austin@dailydrop.com". Harmless (it resolves to nothing)
 *  but it pollutes the parsed set and could in principle collide, so
 *  trim it rather than leave it for a reader to puzzle over. */
function cleanEmail(raw: string): string {
  return raw
    .trim()
    .replace(/^[[(<"']+/, "")
    .replace(/^mailto:/i, "")
    .replace(/[\])>"'.,;]+$/, "")
    .toLowerCase();
}

function normalizeForParsing(text: string): string {
  return text
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/%7C/gi, "|");
}

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

  // Everything below matches against the normalized copy. The preview
  // is built from it too — dropping "> " makes the profile row read
  // better, and the caller keeps the original.
  text = normalizeForParsing(text);

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
  if (emailLine && emailLine[1]) {
    const e = cleanEmail(emailLine[1]);
    if (e.includes("@")) emails.add(e);
  }
  // Any other mailto:.
  for (const m of text.matchAll(new RegExp(MAILTO_RE.source, "gi"))) {
    if (!m[1]) continue;
    const e = cleanEmail(m[1]);
    if (e.includes("@")) emails.add(e);
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
