import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { saveSlackUserOAuthTokens } from "@/lib/data/slack-user-oauth-tokens";

export const dynamic = "force-dynamic";

/**
 * GET /api/slack/user-oauth/callback?code=…&state=<base64 email>
 *
 * Catches Slack's redirect after the admin approves the consent
 * screen. Exchanges the `code` for the initial rotating token pair
 * via `oauth.v2.access` and persists it via saveSlackUserOAuthTokens.
 *
 * On success, redirects the admin back to /settings/slack/user-oauth
 * with `?installed=1` so the settings page can flash "Connected."
 * On any error, redirects with `?error=<slack error>` so the settings
 * page shows a targeted banner instead of a stack trace.
 *
 * ─── Auth model ─────────────────────────────────────────────────
 * Requires signed-in admin session — same posture as /start. The
 * `state` param carries the initiating admin's email; we compare
 * against the current session so a stolen redirect link can't be
 * completed by a different user (would be a mild vulnerability
 * given the token grants search read across the workspace).
 */

interface OAuthAccessResponse {
  ok: boolean;
  error?: string;
  team?: { id?: string; name?: string };
  authed_user?: {
    id?: string;
    scope?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
}

function redirectWithError(base: string, error: string): NextResponse {
  const url = new URL(base);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const settingsUrl = `${url.origin}/settings/slack/user-oauth`;

  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return redirectWithError(settingsUrl, "sign_in_required");
  }
  if (!isAdmin(email)) {
    return redirectWithError(settingsUrl, "forbidden");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const slackError = url.searchParams.get("error");
  if (slackError) {
    return redirectWithError(settingsUrl, slackError);
  }
  if (!code) {
    return redirectWithError(settingsUrl, "missing_code");
  }
  // Verify the initiating admin matches the current session — the
  // authorize link is one-shot and short-lived, so a mismatch means
  // either the link was tampered with or a different admin picked
  // it up. Either way we don't want to store a token under the
  // wrong initiated_by identity.
  if (state) {
    try {
      const initiatedBy = Buffer.from(state, "base64url").toString("utf8");
      if (initiatedBy.toLowerCase() !== email.toLowerCase()) {
        return redirectWithError(settingsUrl, "state_mismatch");
      }
    } catch {
      return redirectWithError(settingsUrl, "invalid_state");
    }
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return redirectWithError(settingsUrl, "missing_credentials");
  }
  const redirectUri = `${url.origin}/api/slack/user-oauth/callback`;

  const exchange = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: exchange.toString(),
  });
  if (!res.ok) {
    return redirectWithError(settingsUrl, `http_${res.status}`);
  }
  const json = (await res.json()) as OAuthAccessResponse;
  if (!json.ok) {
    return redirectWithError(settingsUrl, json.error ?? "unknown_error");
  }
  const teamId = json.team?.id;
  const accessToken = json.authed_user?.access_token;
  const refreshToken = json.authed_user?.refresh_token;
  const expiresIn = json.authed_user?.expires_in;
  const authedUserId = json.authed_user?.id;
  if (
    !teamId ||
    !accessToken ||
    !refreshToken ||
    !expiresIn ||
    !authedUserId
  ) {
    // Missing rotation fields typically means rotation isn't
    // actually enabled on the app. Surface that specifically so
    // the admin can go flip the setting instead of retrying.
    return redirectWithError(settingsUrl, "rotation_not_enabled");
  }
  await saveSlackUserOAuthTokens({
    team_id: teamId,
    team_name: json.team?.name ?? null,
    authed_user_id: authedUserId,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + expiresIn * 1000,
    scope: json.authed_user?.scope ?? "",
    installed_by: email,
    updated_at: new Date().toISOString(),
  });

  const okUrl = new URL(settingsUrl);
  okUrl.searchParams.set("installed", "1");
  okUrl.searchParams.set("team_id", teamId);
  return NextResponse.redirect(okUrl.toString());
}
