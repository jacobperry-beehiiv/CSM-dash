/**
 * Pure parser for Sybill call-recap emails. No Gmail imports, no
 * KV — easy to unit-test against a saved fixture later.
 *
 * Sybill's text/plain body is structured enough that a plain-text
 * regex pass works. The primary source is the **"AI Tasks (N)"**
 * section, which Sybill puts under the Meeting Summary block and
 * formats as:
 *
 *   AI Tasks (2)
 *   -------------------------------
 *
 *    * Jacob Perry: Email call recording link to Frances Popp and team - <details>
 *    * Jacob Perry: Review promo setup email from Wide Moat team - <details>
 *
 * Each bullet is `{Owner}: {Title} - {Details}`. The owner prefix
 * lets us surface who a task belongs to; the ` - ` split separates
 * a short title from the longer prose description.
 *
 * Fallback: legacy "Action Items" / "Next Steps" headings without
 * the AI-Tasks structure. Keeps the parser tolerant of Sybill
 * template drift without another API round-trip.
 */

export interface SybillActionItem {
  /** Short title. When the bullet uses the "Owner: Title - Details"
   *  format we take just the "Title" portion; otherwise the whole
   *  bullet text. */
  title: string;
  /** Longer prose description. Populated from the "- Details" part
   *  of the "Owner: Title - Details" bullet, or null when the bullet
   *  doesn't have that split. */
  details: string | null;
  /** Human-readable owner label from the "Owner:" prefix. Null when
   *  the bullet had no owner tag (typically legacy Action Items
   *  format). Not yet used to route across CSMs — v1 lands every
   *  item on the mailbox owner's list. */
  owner: string | null;
  /** Captured when the bullet ends with a "due by X" / "by EOW"
   *  / "next Tuesday" clause. Not propagated to PersonalTodo
   *  .due_date in v1 (too easy to mis-parse). */
  due_hint?: string;
}

export interface SybillRecap {
  /** Subject-derived title used for the to-do's `details` block.
   *  Stripped of Sybill's "Meeting:" / "Call recap:" prefix so the
   *  body reads naturally. */
  title: string;
  /** When known, the customer / contact named in the call. Extracted
   *  from subjects like "Meeting: Frances Popp and Jacob Perry" or
   *  "Meeting with X" prose in the body. */
  contact_hint?: string;
  /** Sybill's deep link to the call recording / transcript in the
   *  Sybill app. Extracted from the "View in Sybill" or similar
   *  URL when present. */
  call_url?: string;
  action_items: SybillActionItem[];
  /** Which section the parser matched. Surfaces in the sweep's
   *  activity log so an operator can debug when a template shift
   *  starts favoring one branch over another. */
  matched_source: "ai_tasks" | "legacy_action_items";
}

const SUBJECT_PREFIX_RX =
  /^(?:re:\s*)?(?:meeting|call recap|meeting notes|call notes|recap of)\s*[:\-]\s*/i;
// Accept any Sybill subdomain (Sybill routes recap links through
// tracking hosts like url8903.sybill.ai, not always app.sybill.ai).
// Excludes trailing punctuation that commonly wraps a URL in prose.
const SYBILL_CALL_URL_RX =
  /https?:\/\/[a-z0-9-]+\.sybill\.ai\/[^\s"'<>()]+/i;
// "Meeting: X" (no space before colon), "Meeting with X" (space
// before "with"), or "Call with X". Stops at newlines, periods,
// semicolons — and at " is ready" so Sybill's stock subject suffix
// doesn't get folded into the contact.
const CONTACT_HINT_RX =
  /(?:meeting|call)(?:\s*:\s+|\s+with\s+)([A-Z][^\n.;]{1,80}?)(?=\s+is\s+ready|[\n.;]|$)/i;

/**
 * Bullet extractor tuned to Sybill's leading-space + asterisk bullet
 * style (typical output of quoted-printable text emails). Handles
 * `-`, `*`, `•`, and numeric prefixes. Continuation lines (wrapped
 * bullets) fold into their parent bullet.
 */
function extractBullets(block: string): string[] {
  const lines = block.split(/\r?\n/);
  const items: string[] = [];
  let current: string | null = null;
  function flush(): void {
    if (current === null) return;
    const cleaned = current.trim().replace(/\s+/g, " ");
    if (cleaned) items.push(cleaned);
    current = null;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bulletMatch = /^(?:[-*•·●◦▪–—]|\d+[.)])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      flush();
      current = bulletMatch[1];
    } else if (current !== null) {
      current += " " + line;
    }
  }
  flush();
  return items;
}

/**
 * Break "Owner: Title - Details" into components. Sybill's AI Tasks
 * bullets follow this shape exactly. When the shape doesn't match
 * (legacy bullets, weird quoting), fall back to using the whole
 * text as `title` with no owner / details.
 */
function splitOwnerTitleDetails(bullet: string): {
  title: string;
  details: string | null;
  owner: string | null;
} {
  // Owner: prefix. Case-sensitive on the colon; we accept letters,
  // spaces, and a couple of common punctuation marks in the owner
  // name so "Jacob Perry" / "J Cohen" / "Brad Thomas Jr." all work.
  const ownerMatch = /^([A-Z][A-Za-z .'\-]{1,60}):\s+(.+)$/.exec(bullet);
  let owner: string | null = null;
  let rest = bullet;
  if (ownerMatch) {
    owner = ownerMatch[1].trim();
    rest = ownerMatch[2];
  }
  // Split title from details on the first " - " occurrence. Also
  // handle " — " (em-dash) which Sybill sometimes uses.
  const splitMatch = /\s+[-—]\s+/.exec(rest);
  if (splitMatch) {
    const title = rest.slice(0, splitMatch.index).trim();
    const details = rest.slice(splitMatch.index + splitMatch[0].length).trim();
    return { title, details: details || null, owner };
  }
  return { title: rest.trim(), details: null, owner };
}

/**
 * Locate the "AI Tasks (N)" section in text. Returns the slice from
 * after the heading + divider to the next blank-line-separated
 * heading. Returns null when the section isn't present.
 */
function findAiTasksBlock(text: string): string | null {
  const headerRx =
    /(?:^|\n)\s*AI\s*Tasks(?:\s*\(\d+\))?\s*\n[-=]{3,}\s*\n/i;
  const m = headerRx.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  // Sybill's next section header is a title line followed by a dash
  // rule. Stop at the first line that looks like a section heading
  // (short caps text, followed by `---`).
  const nextHeaderRx = /\n\s*\n[A-Z][^\n]{0,60}\n[-=]{3,}/;
  const nextHeader = nextHeaderRx.exec(rest);
  return nextHeader ? rest.slice(0, nextHeader.index) : rest;
}

/** Legacy fallback: find an "Action Items" / "Next Steps" block that
 *  doesn't have the AI-Tasks structure. Uses inline `:` or newline
 *  after the header. */
function findLegacyActionBlock(text: string): string | null {
  const headerRx =
    /(?:^|\n)\s*(?:action\s*items?|next\s*steps?|to[-\s]?dos?)\s*[:\-]?\s*\n/i;
  const m = headerRx.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const nextHeaderRx =
    /\n\s*\n\s*(?:summary|outcome|topics?\s+discussed|key\s+takeaways|key\s+points?|attendees|participants|notes?|sentiment|next\s+meeting|customer\s+goals|future\s+re-engagement|pain\s+points?|interests|participants|signature|view\s+in\s+sybill)\s*[:\-]?\s*\n/i;
  const nextHeader = nextHeaderRx.exec(rest);
  return nextHeader ? rest.slice(0, nextHeader.index) : rest;
}

function isMeaningful(title: string): boolean {
  const lc = title.trim().toLowerCase();
  if (lc.length < 3) return false;
  if (lc === "none" || lc === "n/a" || lc === "no action items") return false;
  return true;
}

function captureDueHint(text: string): string | undefined {
  const m =
    /\b(?:due\s+(?:by\s+)?|by\s+(?:eod|eow|eom)|by\s+(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?|by\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?|by\s+(?:end\s+of\s+(?:day|week|month)))\b[^.,;]{0,40}/i.exec(
      text
    );
  return m ? m[0].trim() : undefined;
}

/** Best-effort HTML → text fallback for the (rare) case where
 *  text/plain is missing. Quoted-printable soft-wraps (`=\n`) are
 *  handled outside this file (Gmail base64-decode collapses them). */
function htmlToTextFallback(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sybill's text/plain body is quoted-printable-encoded, which means
 *  long lines end with `=\n` soft-wraps that the Gmail API's base64
 *  decoder passes through verbatim. Strip them before regex matches
 *  so "Frances Popp\ncontinued line" doesn't split mid-bullet. */
function decodeQuotedPrintableSoftWraps(text: string): string {
  return text.replace(/=\r?\n/g, "");
}

export function parseSybillRecap(args: {
  subject: string;
  html: string | null;
  text: string | null;
}): SybillRecap | null {
  const subject = (args.subject ?? "").trim();
  const rawText =
    args.text && args.text.trim()
      ? args.text
      : args.html
        ? htmlToTextFallback(args.html)
        : "";
  if (!rawText) return null;
  const sourceText = decodeQuotedPrintableSoftWraps(rawText);

  // Primary: AI Tasks. Sybill's structured tasks list — owner-tagged,
  // one-per-CSM-action, best possible source.
  let block = findAiTasksBlock(sourceText);
  let matched_source: SybillRecap["matched_source"] = "ai_tasks";
  if (!block) {
    block = findLegacyActionBlock(sourceText);
    matched_source = "legacy_action_items";
  }
  if (!block) return null;

  const rawBullets = extractBullets(block);
  const action_items: SybillActionItem[] = [];
  for (const bullet of rawBullets) {
    const parts = splitOwnerTitleDetails(bullet);
    if (!isMeaningful(parts.title)) continue;
    const due_hint =
      captureDueHint(parts.title) ??
      (parts.details ? captureDueHint(parts.details) : undefined);
    action_items.push({
      title: parts.title,
      details: parts.details,
      owner: parts.owner,
      due_hint,
    });
  }
  if (action_items.length === 0) return null;

  const title = subject.replace(SUBJECT_PREFIX_RX, "").trim() || subject;
  const contactMatch =
    CONTACT_HINT_RX.exec(subject) ||
    CONTACT_HINT_RX.exec(sourceText.slice(0, 800));
  const contact_hint = contactMatch ? contactMatch[1].trim() : undefined;
  const urlMatch =
    SYBILL_CALL_URL_RX.exec(sourceText) ||
    (args.html ? SYBILL_CALL_URL_RX.exec(args.html) : null);
  const call_url = urlMatch ? urlMatch[0] : undefined;

  return { title, contact_hint, call_url, action_items, matched_source };
}
