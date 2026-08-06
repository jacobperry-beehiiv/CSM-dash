/**
 * Optional CC recipients offered as one-click toggles on the draft
 * creation flows (bulk-drafts modal + single-account outreach modal).
 *
 * These are team leads who want to be copied on outbound CSM email —
 * that's a fixed team choice, not per-customer data, so it lives in a
 * small static list here rather than being derived from the customer
 * book. (Juliet also owns accounts in the book; Richard doesn't, so
 * both are pinned here for a single, predictable source that works
 * regardless of data source / demo mode.)
 *
 * To add or remove someone, edit this list. Emails are written verbatim
 * into the draft's `Cc:` header, so keep them lowercase + exact.
 */

export interface TeamCcOption {
  /** Short label shown on the toggle. */
  label: string;
  /** Address added to the draft's Cc header when toggled on. */
  email: string;
}

export const TEAM_CC_OPTIONS: TeamCcOption[] = [
  { label: "Richard", email: "richard.evans@beehiiv.com" },
  { label: "Juliet", email: "juliet@beehiiv.com" },
];
