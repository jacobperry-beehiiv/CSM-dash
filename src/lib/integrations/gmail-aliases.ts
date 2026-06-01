import { getValidAccessTokenFor } from "../data/gmail-token";

/**
 * Per-account Gmail send-as alias lookup. Single shared helper so the
 * /api/auth/google/aliases (active account) and
 * /api/auth/google/aliases-all (every connected account) routes can
 * share both the parsing logic and the in-process cache.
 *
 * Backed by Gmail's `users.settings.sendAs.list` endpoint. Requires
 * the `gmail.settings.basic` scope on the auth token (per the Gmail
 * API docs — the seemingly-natural `gmail.settings.readonly` does
 * not exist as a real scope; basic is the minimum-privilege option
 * for reading sendAs settings). CSMs whose connection predates the
 * scope return a `needs_reconsent` error so the UI can prompt them
 * to reconnect.
 */

export interface AliasRow {
  email: string;
  /** Display name configured for the alias, if any (e.g. "AM Team"). */
  name: string | null;
  /** True when this alias is the user's default outgoing identity. */
  is_default: boolean;
  /** True when this is the account's own primary address. Always
   *  present; can't be removed in Gmail. */
  is_primary: boolean;
  verified: boolean;
}

export type AliasFetchResult =
  | { kind: "ok"; aliases: AliasRow[] }
  | {
      kind: "error";
      message: string;
      /** Set when the failure is the missing-scope case so the UI can
       *  surface a reconnect prompt instead of a generic error. */
      needs_reconsent?: boolean;
    };

interface SendAsResponse {
  sendAs?: Array<{
    sendAsEmail?: string;
    displayName?: string;
    isDefault?: boolean;
    isPrimary?: boolean;
    verificationStatus?: string;
  }>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { expires: number; result: AliasFetchResult }>();

/** Fetch aliases for a single connected email. Cached for 5 minutes —
 *  both the ok and error branches are cached, so a missing-scope
 *  connection doesn't get re-hit on every page load. */
export async function fetchAliasesFor(
  email: string
): Promise<AliasFetchResult> {
  const cached = cache.get(email);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  let token: string;
  try {
    token = await getValidAccessTokenFor(email);
  } catch (e) {
    const result: AliasFetchResult = {
      kind: "error",
      message: e instanceof Error ? e.message : "Token load failed",
    };
    // Don't cache token-load failures aggressively — they can flip
    // back to ok quickly if the refresh token comes back online.
    cache.set(email, { expires: Date.now() + 30_000, result });
    return result;
  }

  // Wrap the Gmail call in try/catch + a 10s abort timeout. A hung or
  // throwing fetch here previously bubbled all the way to the
  // /aliases-all endpoint, which had no per-account safety net — one
  // bad connection would 500 the whole sweep and the settings page
  // stayed on "Looking up…" forever.
  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      res = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs",
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    const message =
      e instanceof Error
        ? e.name === "AbortError"
          ? "Gmail API timed out after 10s"
          : e.message
        : "Network error reaching Gmail";
    console.error(`[gmail-aliases] fetch failed for ${email}: ${message}`);
    const result: AliasFetchResult = { kind: "error", message };
    cache.set(email, { expires: Date.now() + 30_000, result });
    return result;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403) {
      const result: AliasFetchResult = {
        kind: "error",
        message:
          "Gmail did not grant the gmail.settings.basic scope. Reconnect Gmail to enable alias auto-discovery.",
        needs_reconsent: true,
      };
      cache.set(email, { expires: Date.now() + CACHE_TTL_MS, result });
      return result;
    }
    const result: AliasFetchResult = {
      kind: "error",
      message: `Gmail API ${res.status}: ${body.slice(0, 300)}`,
    };
    console.error(`[gmail-aliases] non-OK for ${email}: ${result.message}`);
    cache.set(email, { expires: Date.now() + 30_000, result });
    return result;
  }

  let raw: SendAsResponse;
  try {
    raw = (await res.json()) as SendAsResponse;
  } catch (e) {
    const result: AliasFetchResult = {
      kind: "error",
      message: `Gmail API returned non-JSON: ${e instanceof Error ? e.message : "parse error"}`,
    };
    console.error(`[gmail-aliases] parse error for ${email}: ${result.message}`);
    cache.set(email, { expires: Date.now() + 30_000, result });
    return result;
  }

  const aliases: AliasRow[] = (raw.sendAs ?? [])
    .filter(
      (a) =>
        a.sendAsEmail &&
        // Only surface verified aliases — sending from an unverified
        // alias either fails or gets silently rewritten by Gmail.
        // Primary always passes since you implicitly "verify" your
        // own account.
        (a.verificationStatus === "accepted" || a.isPrimary === true)
    )
    .map((a) => ({
      email: a.sendAsEmail!.toLowerCase(),
      name: a.displayName?.trim() || null,
      is_default: Boolean(a.isDefault),
      is_primary: Boolean(a.isPrimary),
      verified: true,
    }));

  const result: AliasFetchResult = { kind: "ok", aliases };
  cache.set(email, { expires: Date.now() + CACHE_TTL_MS, result });
  return result;
}

/** Drop any cached alias result (success OR error) for the given email.
 *  Useful when we know the underlying state changed and shouldn't
 *  wait for the natural TTL — e.g. after a reauth that grants new
 *  scopes, or when an admin wants to force-refresh a single account. */
export function invalidateAliasCache(email?: string): void {
  if (email) {
    cache.delete(email);
  } else {
    cache.clear();
  }
}
