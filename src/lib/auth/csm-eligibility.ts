import { loadCustomers } from "../data/load-customers";
import { loadTokenFor } from "../data/gmail-token";

/**
 * Personalization is gated to **CSMs with a Gmail account connected**.
 * That combination is a cheap proxy for "active dashboard user" — a
 * CSM hasn't really set up the dashboard until they've connected
 * Gmail, and we don't want random viewers (admins, sales, the demo
 * fixture) to be able to skin the dashboard for everyone else.
 *
 * The check is two-part:
 *   1. Email appears as a CSM in the customer book (the
 *      `customer_success_manager_email` field on at least one
 *      Customer row).
 *   2. A Gmail token exists in the gmail-token store for that email
 *      (the user completed the OAuth flow at /settings/gmail).
 *
 * Both gates miss → not eligible. Either gate could fail silently
 * (CSM newly hired and not in q10600 yet, OR connected Gmail but
 * dropped from the CSM list); in either case we return false and
 * the caller surfaces the "ineligible" explainer.
 */

const cache = new Map<string, { expires: number; eligible: boolean }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function isCsmWithGmail(
  email: string | null | undefined
): Promise<boolean> {
  if (!email) return false;
  const key = email.trim().toLowerCase();
  if (!key) return false;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.eligible;

  let eligible = false;
  try {
    const [customers, token] = await Promise.all([
      loadCustomers(),
      loadTokenFor(key),
    ]);
    const isCsm = customers.some(
      (c) => c.customer_success_manager_email?.toLowerCase() === key
    );
    eligible = Boolean(isCsm && token);
  } catch {
    // Soft-fail: if either lookup throws, treat as ineligible.
    // Prevents a transient KV or snapshot read failure from
    // accidentally skinning the dashboard for everyone.
    eligible = false;
  }
  cache.set(key, { expires: now + CACHE_TTL_MS, eligible });
  return eligible;
}

/** Bust the eligibility cache for one email. Call after a Gmail
 *  connect/disconnect so the check picks up the new state without
 *  waiting out the TTL. */
export function invalidateCsmEligibility(email: string | null | undefined) {
  if (!email) return;
  cache.delete(email.trim().toLowerCase());
}
