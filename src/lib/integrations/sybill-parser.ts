/**
 * Pure parser for Sybill call-recap emails. No Gmail imports, no
 * KV — easy to unit-test against a saved fixture later.
 *
 * Sybill's emails are deterministic enough that a plain-text regex
 * pass works for the happy path. The HTML walk is a defensive
 * fallback for the case where the text/plain part is missing or
 * mangled (Sybill renders bullets with weird Unicode glyphs in
 * some templates).
 *
 * Returns null when no "Action items" section is found — caller
 * should mark the message processed anyway so we don't re-scan
 * forever.
 */

export interface SybillActionItem {
  text: string;
  /** Captured when the bullet ends with a "due by X" / "by EOW"
   *  / "next Tuesday" clause. We DON'T propagate this to
   *  PersonalTodo.due_date in v1 — too easy to mis-parse. Kept on
   *  the shape so a later pass can fold it in. */
  due_hint?: string;
}

export interface SybillRecap {
  /** Subject-derived title used for the to-do's `details` block.
   *  Stripped of Sybill's "Call recap:" / "Meeting notes:" prefix
   *  when present so the body reads naturally. */
  title: string;
  /** When known, the customer / contact named in the call. Pulled
   *  from "Meeting with X" or similar phrasing. Optional; the to-do
   *  works without it. */
  contact_hint?: string;
  /** Sybill's deep link to the call recording / transcript.
   *  Looks like `https://app.sybill.ai/call/<id>`. */
  call_url?: string;
  action_items: SybillActionItem[];
}

const SUBJECT_PREFIX_RX = /^(?:re:\s*)?(?:call recap|meeting notes|call notes|recap of)\s*[:\-]\s*/i;
const SYBILL_CALL_URL_RX = /https?:\/\/(?:app\.)?sybill\.ai\/[^\s"'<>]+/i;
const CONTACT_HINT_RX = /(?:meeting|call)\s+with\s+([A-Z][^\n.;]{1,80})/i;

/**
 * Section finder. Locates the "Action items" header in plain text
 * and returns the slice of text from there to the next header
 * (or end-of-message). Case-insensitive; tolerates variations
 * like "Action Items", "ACTION ITEMS", "Next Steps".
 */
function findActionItemsBlock(text: string): string | null {
  const headerRx =
    /(?:^|\n)\s*(?:action\s*items?|next\s*steps?|to[-\s]?dos?)\s*[:\-]?\s*\n/i;
  const m = headerRx.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  // Stop at the next blank-line-separated header (a line that's
  // mostly text, ends with a colon, and is followed by content
  // — heuristic, but matches Sybill's typical structure).
  const rest = text.slice(start);
  const nextHeaderRx =
    /\n\s*\n\s*(?:summary|topics?\s+discussed|key\s+points?|attendees|participants|notes?|sentiment|next\s+meeting|signature)\s*[:\-]?\s*\n/i;
  const nextHeader = nextHeaderRx.exec(rest);
  const block = nextHeader ? rest.slice(0, nextHeader.index) : rest;
  return block;
}

/**
 * Bullet extractor. Sybill emails use a mix of `-`, `*`, `•`, and
 * numeric prefixes. We split on newlines, strip a leading bullet
 * marker, and collapse whitespace.
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
    // Bullet marker variants. Includes Unicode bullets and dashes
    // Sybill sometimes uses.
    const bulletMatch = /^(?:[-*•·●◦▪–—]|\d+[.)])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      flush();
      current = bulletMatch[1];
    } else if (current !== null) {
      // Continuation line of the current bullet (wrapped text).
      current += " " + line;
    }
    // Lines that aren't bullets and don't follow a bullet are
    // dropped — they're typically section dividers or stray prose.
  }
  flush();
  return items;
}

/**
 * Strip very common, value-free bullet content. Sybill occasionally
 * emits empty bullets or placeholder text like "None" / "N/A" when
 * the call had no action items.
 */
function isMeaningful(text: string): boolean {
  const lc = text.trim().toLowerCase();
  if (lc.length < 3) return false;
  if (lc === "none" || lc === "n/a" || lc === "no action items") return false;
  return true;
}

/**
 * Try to lift an explicit due-date hint off the end of the bullet.
 * Captures the matched substring AS IS — we don't try to resolve
 * "EOW" → a real date in v1. The caller can decide whether to
 * surface this in the to-do's details.
 */
function captureDueHint(text: string): string | undefined {
  const m =
    /\b(?:due\s+(?:by\s+)?|by\s+(?:eod|eow|eom)|by\s+(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?|by\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?|by\s+(?:end\s+of\s+(?:day|week|month)))\b[^.,;]{0,40}/i.exec(
      text
    );
  return m ? m[0].trim() : undefined;
}

/**
 * Very lightweight HTML → text fallback for when the text/plain
 * part is missing. Strips tags, decodes a handful of common HTML
 * entities, and collapses whitespace.
 */
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

export function parseSybillRecap(args: {
  subject: string;
  html: string | null;
  text: string | null;
}): SybillRecap | null {
  const subject = args.subject?.trim() ?? "";
  // Prefer text/plain — Sybill always includes one and it's cleaner
  // than tag-stripped HTML. Fall back to a tag-strip of the HTML
  // when text isn't available.
  const sourceText =
    args.text && args.text.trim()
      ? args.text
      : args.html
        ? htmlToTextFallback(args.html)
        : "";
  if (!sourceText) return null;

  const block = findActionItemsBlock(sourceText);
  if (!block) return null;
  const rawBullets = extractBullets(block);
  const action_items: SybillActionItem[] = [];
  for (const bullet of rawBullets) {
    if (!isMeaningful(bullet)) continue;
    const due_hint = captureDueHint(bullet);
    action_items.push({ text: bullet, due_hint });
  }
  if (action_items.length === 0) return null;

  const title = subject.replace(SUBJECT_PREFIX_RX, "").trim() || subject;
  const contactMatch = CONTACT_HINT_RX.exec(subject) || CONTACT_HINT_RX.exec(sourceText.slice(0, 500));
  const contact_hint = contactMatch ? contactMatch[1].trim() : undefined;
  const urlMatch = SYBILL_CALL_URL_RX.exec(sourceText) || (args.html ? SYBILL_CALL_URL_RX.exec(args.html) : null);
  const call_url = urlMatch ? urlMatch[0] : undefined;

  return { title, contact_hint, call_url, action_items };
}
