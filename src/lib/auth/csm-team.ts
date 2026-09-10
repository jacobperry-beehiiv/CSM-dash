import { loadCustomers } from "../data/load-customers";
import { loadSettings } from "../data/settings";
import { isAdmin } from "./admin";

/**
 * Server-side check for "is this viewer part of the CSM team?"
 *
 * Looser gate than `isCsmWithGmail` — three ways in:
 *   1. Admin allowlist (env-driven, super-admin only).
 *   2. Customer-book match — email appears as
 *      `customer_success_manager_email` on at least one Customer row.
 *   3. Settings allowlist — email appears in
 *      `settings.access.extra_csm_emails`, editable by admins at
 *      /settings/access. Covers CS leads, managers, or engineers
 *      who need CSM-team access without an assigned book.
 *
 * Used to gate visual chrome that should belong to the CSM team
 * specifically — e.g. the Sherlock-themed dog icon in the to-do
 * celebration sweep — and API routes that CSMs share. Non-CSM
 * viewers (sales, marketing, demo accounts) see the default look
 * and get 403 on those routes.
 */

const cache = new Map<string, { expires: number; isCsm: boolean }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function isCsmTeamMember(
  email: string | null | undefined
): Promise<boolean> {
  if (!email) return false;
  const key = email.trim().toLowerCase();
  if (!key) return false;
  if (isAdmin(key)) return true;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.isCsm;

  let isCsm = false;
  try {
    // Fire both lookups in parallel — loadSettings is a single KV
    // read (~10ms), loadCustomers is a snapshot decrypt + apply
    // overrides (heavier, cached upstream). Running them together
    // keeps the promotion path as fast as the book-only check.
    const [customers, settings] = await Promise.all([
      loadCustomers(),
      loadSettings(),
    ]);
    const inBook = customers.some(
      (c) => c.customer_success_manager_email?.toLowerCase() === key
    );
    const inAllowlist = (settings.access?.extra_csm_emails ?? []).some(
      (e) => e.toLowerCase() === key
    );
    isCsm = inBook || inAllowlist;
  } catch {
    isCsm = false;
  }
  cache.set(key, { expires: now + CACHE_TTL_MS, isCsm });
  return isCsm;
}

/** Bust the cached result for one email — call from the settings
 *  API's PUT handler so a just-added allowlist member doesn't wait
 *  5 min for the cached "not a CSM" verdict to expire. Passing
 *  `null` clears every entry (useful on bulk-list overwrite). */
export function invalidateCsmTeamCache(email?: string | null): void {
  if (email == null) {
    cache.clear();
    return;
  }
  cache.delete(email.trim().toLowerCase());
}
