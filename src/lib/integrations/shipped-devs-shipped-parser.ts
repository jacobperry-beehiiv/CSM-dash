/**
 * Parse #devs-shipped release posts into structured shipped-hits.
 *
 * The channel's fixed template looks like:
 *
 *   *Custom Domains V3*
 *   • linear.app/beehiiv/issue/BEE-24176 (Bug): Missing Rails routes
 *     ↳ #29056: fix: add missing Rails routes by Phil Mills
 *
 *   Deployed by jack.culpan on Aug 28, 2026 at 07:39 AM PT
 *
 * Every message can carry multiple linear.app URLs (one per ticket in
 * the release), each with a work-type in parens. A ticket that appears
 * in several release posts uses the FIRST post as its ship date —
 * subsequent hits are ignored per the PDF's Piece 3 rule.
 *
 * We parse for structure — regex over the deterministic markers —
 * rather than trying to infer intent. The full message text is
 * preserved on each hit for the audit trail.
 */

/** `linear.app/beehiiv/issue/<KEY>` where KEY is the identifier (e.g.
 *  BEE-24176 / REQ-2207). Kept loose on the domain so a copy that
 *  drops the https:// still matches. */
const LINEAR_URL_RE =
  /(?:https?:\/\/)?linear\.app\/beehiiv\/issue\/([A-Z]+-\d+)/gi;

/** Work-type in parens immediately after the linear.app URL. Values
 *  we've seen in the wild: Bug, Feature, UI/UX Improvement. Captured
 *  as-is; the promotion state machine maps them onto our
 *  WorkTypeLabel union. */
const WORK_TYPE_RE = /linear\.app\/beehiiv\/issue\/[A-Z]+-\d+\s*\(([^)]+)\)/i;

/** "Deployed by <handle> on <Month day, year> at <HH:MM AM/PM TZ>"
 *  — the last line of every release post. TZ abbreviations vary (PT,
 *  ET, UTC) so we don't try to parse to a strict Date; we keep the
 *  original string on the audit trail and derive an approximate
 *  ISO timestamp from the message's Slack `ts` field instead
 *  (Slack ts is a UNIX epoch, always reliable). */
const DEPLOYED_ON_RE =
  /Deployed by [^\s]+ on ([A-Z][a-z]+ \d{1,2},? \d{4}) at (\d{1,2}:\d{2} [AP]M(?: \w{2,4})?)/i;

export interface DevsShippedHit {
  linear_key: string;
  work_type_raw: string | null;
  deployed_at_iso: string; // From Slack ts (definitive)
  deployed_at_label: string | null; // From the message body (human)
  ship_permalink: string | null;
  message_ts: string;
}

/** Convert a Slack `ts` (float seconds since epoch) to an ISO
 *  timestamp. Slack ts is documented as always a Unix epoch — we
 *  parse defensively so a stringy-but-numeric value doesn't blow up. */
function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

/** Parse a single message's text into zero-or-more Linear hits. A
 *  release post typically emits one hit per ticket listed. The
 *  promotion engine dedupes on `linear_key` afterwards. */
export function parseDevsShippedMessage(args: {
  text: string;
  message_ts: string;
  ship_permalink?: string | null;
}): DevsShippedHit[] {
  const { text, message_ts, ship_permalink } = args;
  const deployedMatch = DEPLOYED_ON_RE.exec(text);
  const deployedLabel = deployedMatch
    ? `${deployedMatch[1]} at ${deployedMatch[2]}`
    : null;
  const deployedIso = slackTsToIso(message_ts);

  const hits: DevsShippedHit[] = [];
  // Reset regex state — the /g flag makes RegExp stateful.
  LINEAR_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINEAR_URL_RE.exec(text)) !== null) {
    const key = match[1];
    // Look for a work-type immediately after this specific URL. We
    // slice the message to the ~40 chars following the URL and run
    // the anchored WORK_TYPE_RE so the parens for later tickets in
    // the same post don't get misattributed.
    const start = match.index;
    const tail = text.slice(start, start + 200);
    const wtMatch = WORK_TYPE_RE.exec(tail);
    hits.push({
      linear_key: key,
      work_type_raw: wtMatch ? wtMatch[1].trim() : null,
      deployed_at_iso: deployedIso,
      deployed_at_label: deployedLabel,
      ship_permalink: ship_permalink ?? null,
      message_ts,
    });
  }
  return hits;
}
