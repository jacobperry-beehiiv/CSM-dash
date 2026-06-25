import type { Customer } from "../types";

/**
 * Derive the "this customer's email domain(s)" signal set for a
 * Customer record, used by the Gmail sweep to broaden its query
 * beyond a single owner_email match.
 *
 * Rationale: the sweep used to query Gmail for `from:owner OR
 * to:owner` only — so CSMs who emailed a non-primary contact (or a
 * brand-new HubSpot-untracked person at the same company) saw
 * those messages silently dropped. We now add `from:@domain OR
 * to:@domain` clauses so anyone at the customer's company surfaces.
 *
 * Two important guardrails:
 *
 *   1. Free-email domains are excluded from the domain-match path.
 *      A customer whose owner_email is `tom@gmail.com` legitimately
 *      uses Gmail — and `to:@gmail.com OR from:@gmail.com` would
 *      flood the result with every Gmail user the CSM has ever
 *      messaged. For those customers we fall back to the specific
 *      email addresses we know about (still better than the old
 *      owner-only path because hubspot_contacts get included).
 *
 *   2. Our own domain (beehiiv.com) is always excluded — every
 *      internal email would match otherwise.
 */

/** Domains where "everyone at this domain is at this customer" is
 *  not true. Excludes the consumer email providers we've seen
 *  customers use as their primary contact. Conservative; add more
 *  as they show up. */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "fastmail.fm",
  "zoho.com",
  "tutanota.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
]);

/** Our own domain — anyone @beehiiv.com is a teammate, not a
 *  customer contact. */
const OWN_DOMAIN = "beehiiv.com";

export interface CustomerEmailSignals {
  /** Specific email addresses to OR-match individually (always
   *  included, even when their domain is also queried). */
  emails: string[];
  /** Domain-match clauses — `from:@domain OR to:@domain` — to add
   *  to the Gmail query. Empty when the customer's contacts all
   *  use free-email providers (we don't want to query the world). */
  domains: string[];
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at >= email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Build the email + domain signals for a customer record.
 *
 *   • emails: owner_email + every hubspot_contacts[].email,
 *     deduped + lower-cased.
 *   • domains: the unique non-free, non-own domains seen across
 *     those emails.
 *
 * Returns empty arrays when the customer has no known contact
 * email at all — the sweep callers skip these (nothing to query).
 */
export function customerEmailSignals(c: Customer): CustomerEmailSignals {
  const emails = new Set<string>();
  const domains = new Set<string>();

  function add(email: string | null | undefined): void {
    if (!email) return;
    const lc = email.trim().toLowerCase();
    if (!lc) return;
    emails.add(lc);
    const d = emailDomain(lc);
    if (!d) return;
    if (d === OWN_DOMAIN) return;
    if (FREE_EMAIL_DOMAINS.has(d)) return;
    domains.add(d);
  }

  add(c.owner_email);
  for (const contact of c.hubspot_contacts ?? []) {
    add(contact.email);
  }

  return {
    emails: Array.from(emails),
    domains: Array.from(domains),
  };
}
