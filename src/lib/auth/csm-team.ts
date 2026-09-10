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
 *
 * ─── Caching ───────────────────────────────────────────────────────
 * ONLY positive verdicts are cached, and only for a short 60s window.
 *
 * Why: Vercel's serverless isolates each hold their own module-scope
 * cache. A prior 5-min cache of negative verdicts across many warm
 * isolates meant that a just-promoted user (added to the allowlist
 * via /settings/access) had to wait up to 5 minutes for the "false"
 * verdict to expire in whichever isolate their next request landed
 * on — the invalidateCsmTeamCache() call inside the settings API
 * only busts the ONE isolate that handled the PUT. Not caching
 * negative verdicts means a promoted user picks up on their very
 * next request, no matter which isolate serves it.
 *
 * The underlying loadCustomers() (memoized) + loadSettings() (single
 * small KV read) cost is trivial, so paying it per negative check
 * is fine.
 */

const positiveCache = new Map<string, number>();
/** Short enough that a demoted user gets locked out quickly across
 *  isolates without an explicit invalidation call, but long enough
 *  to absorb the burst of checks a single page load triggers.
 *  60s is a middle ground. */
const POSITIVE_TTL_MS = 60 * 1000;

export async function isCsmTeamMember(
  email: string | null | undefined
): Promise<boolean> {
  if (!email) return false;
  const key = email.trim().toLowerCase();
  if (!key) return false;
  if (isAdmin(key)) return true;
  const now = Date.now();
  const expiresAt = positiveCache.get(key);
  if (expiresAt && expiresAt > now) return true;

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
  if (isCsm) {
    // Cache only the positive verdict so a single page load's burst
    // of checks reuses one lookup. Negative verdicts stay uncached
    // so a just-promoted user picks up on the next request.
    positiveCache.set(key, now + POSITIVE_TTL_MS);
  }
  return isCsm;
}

/** Bust the cached positive verdict for one email — call from the
 *  settings API's PUT handler so a just-demoted member doesn't stay
 *  authorized for another 60s (in the one isolate that handled the
 *  PUT). Passing `null` clears every entry. Note: the "just added"
 *  case doesn't need this because negative verdicts are never cached. */
export function invalidateCsmTeamCache(email?: string | null): void {
  if (email == null) {
    positiveCache.clear();
    return;
  }
  positiveCache.delete(email.trim().toLowerCase());
}
