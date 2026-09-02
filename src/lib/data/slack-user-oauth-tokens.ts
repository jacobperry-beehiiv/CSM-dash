/**
 * Slack user-token KV store — persisted rotating-token pair for the
 * D&C Upgrade Analysis Slack search feature.
 *
 * Slack's `search.messages` endpoint requires a USER token (`xoxp-…`)
 * — bot tokens are rejected. With token rotation enabled on our app,
 * the initial `access_token` + `refresh_token` pair is only ever
 * emitted once, via the OAuth callback response. There's no page in
 * Slack's admin UI where you can copy a static value, so the tokens
 * MUST be caught by our callback and persisted here.
 *
 * Shape: one row per Slack workspace (we install into just beehiiv's,
 * so this is effectively a singleton for now — keyed on team_id so a
 * future multi-workspace install slots in without a migration).
 *
 * ─── Rotation contract (from docs.slack.dev/authentication/using-token-rotation) ────
 *   - access_token expires in 12h (43200s). We refresh 60s early so
 *     the refresh call and the API call can share the token safely.
 *   - refresh_token expires in 200d. Refreshing rotates BOTH tokens
 *     — the response body contains a NEW refresh_token that
 *     invalidates the one we just sent. We write the new pair back
 *     in the same request; a 60s grace period on the old refresh
 *     handles the "network blip between refresh and write" case.
 *   - Concurrent refresh attempts race: two callers using the same
 *     refresh_token → the second gets `invalid_refresh_token` and
 *     the first's new pair is now the only valid one. Fix is
 *     single-flighted in the helper (see slack-user-token.ts).
 */

import { kvGet, kvSet, kvDelete } from "../storage/kv";

const KV_KEY_PREFIX = "csm:slack-user-oauth:v1:";

export interface SlackUserOAuthTokens {
  /** Slack workspace / team id. Used as the KV key discriminator so
   *  a future Grid-org install slots in without a schema change. */
  team_id: string;
  /** Human-readable workspace name for the settings UI ("beehiiv"). */
  team_name: string | null;
  /** Slack user id of the admin who installed. Surfaced in the UI so
   *  the team knows whose "eyes" the search runs as. Rotation
   *  preserves this — the identity doesn't change on refresh. */
  authed_user_id: string;
  /** The current `xoxp-…` user token. Refreshed in place by the
   *  helper. Never persisted anywhere else — this row is the sole
   *  source of truth so a rotation can't leave two writers fighting. */
  access_token: string;
  /** Single-use `xoxe-…` refresh token. Consumed on every refresh
   *  and replaced with a fresh one in the response body. */
  refresh_token: string;
  /** Epoch millis at which `access_token` stops being accepted.
   *  Computed at persistence time as `now + expires_in * 1000`. */
  expires_at: number;
  /** Comma-separated scope string as reported by Slack — kept so
   *  the settings UI can show what the token can actually do. */
  scope: string;
  /** Email of the CSM Mission Control admin who triggered the
   *  install. Distinct from `authed_user_id` (that's the Slack user
   *  identity). Used for audit only. */
  installed_by: string;
  /** ISO timestamp of the most recent write (initial install or
   *  refresh). Powers "last refreshed at …" in the settings UI so
   *  admins can spot a stuck rotation. */
  updated_at: string;
}

export async function loadSlackUserOAuthTokens(
  teamId: string
): Promise<SlackUserOAuthTokens | null> {
  const key = KV_KEY_PREFIX + teamId;
  return (await kvGet<SlackUserOAuthTokens>(key)) ?? null;
}

export async function saveSlackUserOAuthTokens(
  tokens: SlackUserOAuthTokens
): Promise<void> {
  const key = KV_KEY_PREFIX + tokens.team_id;
  await kvSet<SlackUserOAuthTokens>(key, tokens);
}

export async function deleteSlackUserOAuthTokens(
  teamId: string
): Promise<void> {
  const key = KV_KEY_PREFIX + teamId;
  await kvDelete(key);
}

/** Default team id used for the singleton install. beehiiv's Slack
 *  workspace id is stable, so we can hardcode a lookup default; a
 *  future multi-tenant install path could pass its own team_id.
 *
 *  Env override: SLACK_USER_OAUTH_TEAM_ID lets us point staging at a
 *  test workspace without a redeploy. Defaults to the string
 *  "default" so on a fresh install the KV key is deterministic — the
 *  callback writes to `csm:slack-user-oauth:v1:<team_id>` using the
 *  team_id it gets back from Slack, and later reads use whatever
 *  this env var points at. */
export function defaultSlackTeamId(): string {
  return process.env.SLACK_USER_OAUTH_TEAM_ID?.trim() || "default";
}
