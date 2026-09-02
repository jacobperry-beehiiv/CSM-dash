/**
 * Slack user-token refresh helper.
 *
 * Reads the persisted rotating-token pair, refreshes when the access
 * token is within the safety window of expiring, writes the new pair
 * back, and returns the fresh access token. Callers use it in place
 * of `process.env.SLACK_USER_TOKEN` — the env var is no longer valid
 * with rotation enabled on the Slack app (rotated tokens are only
 * ever visible in the OAuth callback response, never in a static
 * config UI).
 *
 * ─── Rotation semantics ─────────────────────────────────────────────
 * Slack's `oauth.v2.access` with `grant_type=refresh_token` rotates
 * BOTH tokens on every call: the response body contains a new
 * access_token AND a new refresh_token. The one we sent in the
 * request is invalidated (grace period ~60s per docs.slack.dev). If
 * we lose the response mid-write, the 60s grace period lets a retry
 * with the same input succeed once.
 *
 * ─── Race handling ──────────────────────────────────────────────────
 * If two callers refresh concurrently with the same refresh_token,
 * the second gets `invalid_refresh_token` and the first's new pair
 * becomes the only valid one. We single-flight the refresh in
 * module-scope so N concurrent readers share one refresh POST.
 */

import {
  loadSlackUserOAuthTokens,
  saveSlackUserOAuthTokens,
  type SlackUserOAuthTokens,
} from "../data/slack-user-oauth-tokens";

const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
/** Refresh this many ms before the stored expiry. The Slack docs cite
 *  a 60s grace period on the OLD token; refreshing 60s early means a
 *  request that started right at the expiry boundary can still
 *  complete on the previous token while the refresh runs. */
const REFRESH_SAFETY_WINDOW_MS = 60_000;

/** Result of getFreshSlackUserToken. `ok` returns the token to use;
 *  the other kinds are diagnostic so slack-search.ts can surface a
 *  meaningful status banner instead of silently returning `[]`. */
export type GetFreshTokenOutcome =
  | { kind: "ok"; token: string; expires_at: number; team_id: string }
  | { kind: "not_configured"; detail: string }
  | { kind: "refresh_failed"; detail: string };

/** Module-scoped promise so N concurrent callers share the refresh
 *  round-trip. Cleared once the refresh settles (success or failure)
 *  so the next request re-checks the store. Singleton install → one
 *  slot is enough. */
let inflight: Promise<GetFreshTokenOutcome> | null = null;

export async function getFreshSlackUserToken(): Promise<GetFreshTokenOutcome> {
  if (inflight) return inflight;

  inflight = (async (): Promise<GetFreshTokenOutcome> => {
    const stored = await loadSlackUserOAuthTokens();
    if (!stored) {
      return {
        kind: "not_configured",
        detail:
          "No Slack user token stored — connect the workspace at /settings/slack/user-oauth.",
      };
    }
    const now = Date.now();
    if (stored.expires_at - now > REFRESH_SAFETY_WINDOW_MS) {
      // Still fresh — no refresh needed.
      return {
        kind: "ok",
        token: stored.access_token,
        expires_at: stored.expires_at,
        team_id: stored.team_id,
      };
    }
    // Expired or within the safety window — refresh, write back,
    // return the new access token.
    return refreshAndPersist(stored);
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

interface OAuthAccessResponse {
  ok: boolean;
  error?: string;
  // Rotation response shape — user-token flow only. The bot half of a
  // /oauth.v2.access response has its own access_token at the top;
  // for rotation refresh we exchange for the same token type we
  // originally minted, so a user-token grant yields these fields.
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  team?: { id?: string; name?: string };
  authed_user?: {
    id?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
}

async function refreshAndPersist(
  stored: SlackUserOAuthTokens
): Promise<GetFreshTokenOutcome> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      kind: "refresh_failed",
      detail:
        "SLACK_CLIENT_ID / SLACK_CLIENT_SECRET must be set — can't refresh without app credentials.",
    };
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
  });
  const res = await fetch(SLACK_OAUTH_ACCESS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    return {
      kind: "refresh_failed",
      detail: `oauth.v2.access HTTP ${res.status}`,
    };
  }
  const json = (await res.json()) as OAuthAccessResponse;
  if (!json.ok) {
    return {
      kind: "refresh_failed",
      detail:
        json.error === "invalid_refresh_token"
          ? "invalid_refresh_token — reinstall the Slack user token at /settings/slack/user-oauth."
          : json.error ?? "unknown_error",
    };
  }
  // Slack's refresh response for a user token puts the new pair
  // under `authed_user`; the top-level `access_token` reflects the
  // bot half (absent on a user-token refresh). Fall back to the
  // top-level shape defensively — some SDKs report it there too.
  const nextAccess =
    json.authed_user?.access_token ?? json.access_token ?? null;
  const nextRefresh =
    json.authed_user?.refresh_token ?? json.refresh_token ?? null;
  const expiresIn =
    json.authed_user?.expires_in ?? json.expires_in ?? null;
  if (!nextAccess || !nextRefresh || !expiresIn) {
    return {
      kind: "refresh_failed",
      detail:
        "oauth.v2.access response missing rotation fields — check that rotation is still enabled on the Slack app.",
    };
  }
  const nextTokens: SlackUserOAuthTokens = {
    ...stored,
    access_token: nextAccess,
    refresh_token: nextRefresh,
    expires_at: Date.now() + expiresIn * 1000,
    scope: json.authed_user?.scope ?? json.scope ?? stored.scope,
    updated_at: new Date().toISOString(),
  };
  await saveSlackUserOAuthTokens(nextTokens);
  return {
    kind: "ok",
    token: nextAccess,
    expires_at: nextTokens.expires_at,
    team_id: nextTokens.team_id,
  };
}
