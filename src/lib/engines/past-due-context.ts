import type { PastDueRow } from "./am-cohorts";

/**
 * Helpers that map a PastDueRow's raw Stripe charge metadata into
 * email-ready prose for the {{MONTH}} and {{REASON}} merge tags.
 *
 * Kept in its own module so the engine + the bulk-drafts panel +
 * any future renderer can share the same phrasing without anyone
 * having to copy/paste the Stripe code → readable phrase mapping.
 */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Format a Stripe charge_attempted_at ISO timestamp as the full
 * English month name. Returns null when the value is missing or
 * unparseable so callers can decide whether to render "—" or skip
 * the tag entirely.
 *
 * UTC month boundary intentional — every Past Due row comes from a
 * snapshot keyed in UTC, and an "April 30 23:30 UTC" charge that
 * actually retried at "May 1 03:30 UTC" should bucket to May to
 * match the customer's Stripe statement.
 */
export function pastDueMonth(row: PastDueRow): string | null {
  if (!row.charge_attempted_at) return null;
  const d = new Date(row.charge_attempted_at);
  const m = d.getUTCMonth();
  if (!Number.isInteger(m) || m < 0 || m > 11) return null;
  return MONTH_NAMES[m];
}

/**
 * Human-readable phrase explaining why a Stripe charge failed.
 * Designed to drop straight into "Your charge failed {{REASON}}."
 * so each return value starts with "due to ".
 *
 * Mapping covers the codes Stripe surfaces most often (drawn from
 * https://docs.stripe.com/declines/codes). Anything we don't have
 * an explicit mapping for falls through to a generic phrase — the
 * point is to never embarrass the email with a raw API code like
 * "insufficient_funds" in the body text.
 *
 * If `failure_code` is missing but `failure_message` is set, we
 * surface the message verbatim (lowercased + leading "due to" if
 * not already present). This catches edge cases where Stripe
 * returned a message without a structured code.
 */
export function pastDueReason(row: PastDueRow): string | null {
  const code = (row.failure_code ?? "").trim().toLowerCase();
  const mapped = REASON_BY_CODE[code];
  if (mapped) return mapped;
  if (code) {
    // Unknown code with a meaningful name — drop the underscores
    // and hand it back as prose. "lost_card" → "due to a lost card".
    return `due to ${code.replace(/_/g, " ")}`;
  }
  const msg = (row.failure_message ?? "").trim();
  if (msg) {
    // Strip "Your card was declined." / similar leading clauses so
    // the result still reads as a "due to …" tail.
    const lower = msg.toLowerCase().replace(/\.$/, "");
    if (lower.startsWith("due to ")) return lower;
    return `due to ${lower}`;
  }
  return null;
}

const REASON_BY_CODE: Record<string, string> = {
  insufficient_funds: "due to insufficient funds",
  card_declined: "due to a card decline",
  generic_decline: "due to a card decline",
  do_not_honor: "due to a card decline",
  transaction_not_allowed: "due to a card decline",
  expired_card: "due to an expired card",
  incorrect_cvc: "due to an incorrect CVC",
  incorrect_number: "due to an incorrect card number",
  invalid_card_type: "due to an unsupported card type",
  invalid_account: "due to an invalid account",
  lost_card: "due to a reported lost card",
  stolen_card: "due to a reported stolen card",
  pickup_card: "due to the issuing bank flagging the card",
  processing_error: "due to a processing error",
  authentication_required: "because the card requires additional authentication",
  approve_with_id: "because the issuing bank needs to verify the cardholder",
  call_issuer: "because the issuing bank needs the cardholder to call",
  fraudulent: "because the issuing bank flagged the charge as fraudulent",
  withdrawal_count_limit_exceeded:
    "because the card hit its withdrawal limit",
  card_velocity_exceeded:
    "because the card has been used too many times recently",
  currency_not_supported: "because the card doesn't support this currency",
  try_again_later: "due to a temporary issue at the issuing bank",
};
