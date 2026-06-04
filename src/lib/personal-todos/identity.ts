import type { Customer } from "../types";
import type { CsmSlackIdMap } from "../data/settings-types";

/**
 * Identity resolution for the personal todos feature.
 *
 * Two entry points need to converge on the same KV key:
 *
 *   1. The API layer, where `auth()` gives us a NextAuth session with
 *      an @beehiiv.com email.
 *   2. The Slack webhook, where Slack hands us a `user.id` (U…) and we
 *      need to discover which CSM that is.
 *
 * The canonical key is the lower-cased email. For Slack inbound we
 * reverse-look up the existing `csm_user_ids: Record<handle, slack_id>`
 * map (managed in /settings/slack) to find a handle, then the customer
 * book to find that handle's email. No new settings field needed.
 *
 * When Slack lookup fails (handle not in customer book, slack_id not
 * in the map) the webhook should respond with a friendly error so the
 * sender can ask an admin to add their mapping. We return null for
 * those cases rather than guessing.
 */

/** Canonical key from the logged-in CSM's email. Lower-cased to avoid
 *  splitting Jacob.Perry@beehiiv.com vs jacob.perry@beehiiv.com into
 *  two distinct buckets. */
export function userKeyFromEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Reverse-lookup a Slack user_id (U…) to the canonical key (email).
 * Returns null when:
 *   - The slack_id isn't in `csm_user_ids` (admin hasn't mapped them).
 *   - The handle is in the map but has no customer-book entry with an
 *     email (rare — usually means the CSM has no accounts assigned
 *     yet, e.g. a new hire still being onboarded).
 *
 * The customer book is passed in by the caller so this helper stays
 * pure / testable and doesn't trigger a fresh load each time.
 */
export function userKeyFromSlackUserId(
  slackUserId: string,
  csmUserIds: CsmSlackIdMap,
  customers: Customer[]
): string | null {
  if (!slackUserId) return null;

  // Reverse-lookup handle from slack_id. The map is keyed by handle so
  // we have to scan; it's small (handful of CSMs) so O(n) is fine.
  let handle: string | null = null;
  for (const [h, sid] of Object.entries(csmUserIds)) {
    if (sid === slackUserId) {
      handle = h;
      break;
    }
  }
  if (!handle) return null;

  // Resolve handle → email via the customer book. `customer_success_manager`
  // is the snake_case handle (e.g. "Jacob_Perry"); `customer_success_manager_email`
  // is the @beehiiv.com address. Multiple customers may share the same
  // CSM — the first match wins (the email is the same regardless).
  for (const c of customers) {
    if (
      c.customer_success_manager === handle &&
      c.customer_success_manager_email
    ) {
      return userKeyFromEmail(c.customer_success_manager_email);
    }
  }
  return null;
}
