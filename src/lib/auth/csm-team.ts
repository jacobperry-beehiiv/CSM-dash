import { loadCustomers } from "../data/load-customers";
import { isAdmin } from "./admin";

/**
 * Server-side check for "is this viewer part of the CSM team?"
 *
 * Looser gate than `isCsmWithGmail` — checks only that the email
 * appears as `customer_success_manager_email` on at least one
 * Customer row (i.e. they're an assigned CSM in the book). The
 * admin allowlist is also considered "CSM team" so the
 * super-admin sees the same CSM-team chrome the rest of the team
 * does.
 *
 * Used to gate visual chrome that should belong to the CSM team
 * specifically — e.g. the Sherlock-themed dog icon in the to-do
 * celebration sweep. Non-CSM viewers (sales, marketing, demo
 * accounts) see the default look.
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
    const customers = await loadCustomers();
    isCsm = customers.some(
      (c) => c.customer_success_manager_email?.toLowerCase() === key
    );
  } catch {
    isCsm = false;
  }
  cache.set(key, { expires: now + CACHE_TTL_MS, isCsm });
  return isCsm;
}
