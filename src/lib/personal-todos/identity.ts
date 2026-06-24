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
 * Resolution chain for Slack inbound, in order:
 *
 *   a. Reverse-lookup the `csm_user_ids: Record<handle, slack_id>` map
 *      maintained at /settings/slack. Trim whitespace from stored
 *      values — admins occasionally paste with stray spaces.
 *   b. Bridge the handle to an email via the customer book
 *      (`customer_success_manager` == handle → `customer_success_manager_email`).
 *      Case-flexible match so capitalization drift between the
 *      settings map and q10600 doesn't break the chain.
 *   c. (fallback) Call Slack's `users.info` for the user_id and read
 *      the email off their profile. Requires the `users:read.email`
 *      scope on the bot. Catches the case where a CSM is mapped in
 *      csm_user_ids but has no accounts in the customer book yet
 *      (new hires, role-switch in progress).
 *
 * Returns the canonical key (lower-cased email) when any step
 * succeeds; null when even the Slack fallback can't resolve.
 */

/** Canonical key from the logged-in CSM's email. Lower-cased to avoid
 *  splitting Jacob.Perry@beehiiv.com vs jacob.perry@beehiiv.com into
 *  two distinct buckets. */
export function userKeyFromEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface ResolveResult {
  userKey: string | null;
  /** Which step the chain landed on — useful for diagnostic logging. */
  via: "csm_user_ids+customer_book" | "slack_users_info" | null;
  /** Hint at why null was returned, surfaced in the bounce DM so the
   *  user knows what to ask an admin for. */
  reason?: string;
}

/**
 * Async variant that includes the Slack users.info fallback. The
 * caller (webhook) handles the chain end-to-end so the bounce
 * message can be specific about which step failed.
 */
export async function resolveUserKeyForSlackId(
  slackUserId: string,
  csmUserIds: CsmSlackIdMap,
  customers: Customer[]
): Promise<ResolveResult> {
  if (!slackUserId) {
    return { userKey: null, via: null, reason: "no slack user id" };
  }
  const targetId = slackUserId.trim();

  // ─── Step a: csm_user_ids reverse-lookup ──────────────────────────
  let handle: string | null = null;
  for (const [h, sid] of Object.entries(csmUserIds)) {
    if (typeof sid !== "string") continue;
    if (sid.trim() === targetId) {
      handle = h;
      break;
    }
  }

  // ─── Step b: customer book bridge ─────────────────────────────────
  if (handle) {
    const handleLc = handle.toLowerCase();
    for (const c of customers) {
      const csmHandle = c.customer_success_manager;
      if (!csmHandle) continue;
      if (
        csmHandle === handle ||
        csmHandle.toLowerCase() === handleLc
      ) {
        if (c.customer_success_manager_email) {
          return {
            userKey: userKeyFromEmail(c.customer_success_manager_email),
            via: "csm_user_ids+customer_book",
          };
        }
      }
    }
  }

  // ─── Step c: Slack users.info fallback ────────────────────────────
  // Catches CSMs who are correctly mapped in csm_user_ids but don't
  // appear in the customer book (no accounts assigned yet) or whose
  // book entry has a null email. Requires `users:read.email` scope.
  //
  // Hard gate: the fallback email must match a known CSM email in
  // the customer book. Without this gate, anyone with a @beehiiv.com
  // address who DMs the bot once opens their own todo bucket — that's
  // how `tyler@`, `kanishka@`, etc. ended up in the admin panel.
  // New-hire CSMs who aren't in the book yet should be added to
  // csm_user_ids OR the customer book before they can use the feature.
  const fallback = await fetchSlackUserEmail(targetId);
  if (fallback) {
    const fallbackKey = userKeyFromEmail(fallback);
    const knownCsm = customers.some(
      (c) =>
        c.customer_success_manager_email?.trim().toLowerCase() === fallbackKey
    );
    if (knownCsm) {
      return { userKey: fallbackKey, via: "slack_users_info" };
    }
    return {
      userKey: null,
      via: null,
      reason: `${fallback} isn't recognized as a CSM — this feature is only available to CSMs (must appear as a customer_success_manager_email in the customer book, or be mapped at /settings/slack → CSM Slack IDs)`,
    };
  }

  // Couldn't resolve — produce a reason hint so the webhook's bounce
  // DM can be specific about what to fix.
  if (!handle) {
    return {
      userKey: null,
      via: null,
      reason:
        "your Slack ID isn't in the CSM Slack IDs map at /settings/slack",
    };
  }
  return {
    userKey: null,
    via: null,
    reason: `handle "${handle}" is mapped to your Slack ID but I couldn't find an @beehiiv.com email for it — the customer book has no account assigned to that handle and Slack users.info didn't return an email (the bot may need users:read.email scope)`,
  };
}

/**
 * Synchronous variant retained for the sweep path where we need
 * email → slack_id resolution without making a network call per user.
 * The sweep uses a different direction (userKey → slackId), so it
 * doesn't need the fallback.
 *
 * Kept for backward compatibility with existing callers that don't
 * want to await Slack.
 */
export function userKeyFromSlackUserId(
  slackUserId: string,
  csmUserIds: CsmSlackIdMap,
  customers: Customer[]
): string | null {
  if (!slackUserId) return null;
  const targetId = slackUserId.trim();
  let handle: string | null = null;
  for (const [h, sid] of Object.entries(csmUserIds)) {
    if (typeof sid !== "string") continue;
    if (sid.trim() === targetId) {
      handle = h;
      break;
    }
  }
  if (!handle) return null;
  const handleLc = handle.toLowerCase();
  for (const c of customers) {
    const csmHandle = c.customer_success_manager;
    if (!csmHandle) continue;
    if (
      (csmHandle === handle || csmHandle.toLowerCase() === handleLc) &&
      c.customer_success_manager_email
    ) {
      return userKeyFromEmail(c.customer_success_manager_email);
    }
  }
  return null;
}

/** Best-effort email lookup via Slack's users.info. Returns null on
 *  any error (missing token, missing scope, Slack outage) so the
 *  caller can decide whether to bounce or guess. */
async function fetchSlackUserEmail(
  slackUserId: string
): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  try {
    const params = new URLSearchParams({ user: slackUserId });
    const r = await fetch(
      `https://slack.com/api/users.info?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = (await r.json()) as {
      ok: boolean;
      error?: string;
      user?: { profile?: { email?: string } };
    };
    if (!j.ok) {
      console.warn(
        "[identity] Slack users.info failed",
        { slackUserId, error: j.error }
      );
      return null;
    }
    return j.user?.profile?.email ?? null;
  } catch (e) {
    console.warn(
      "[identity] Slack users.info threw",
      { slackUserId, error: e instanceof Error ? e.message : String(e) }
    );
    return null;
  }
}
