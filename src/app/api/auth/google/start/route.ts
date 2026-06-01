import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Minimum scope set — works as long as the Google Cloud project's
 *  OAuth consent screen has them all listed (these have been on the
 *  consent screen since day one). */
const CORE_SCOPES = [
  "openid",
  "email",
  "profile",
  // Compose lets us create drafts. We deliberately do NOT request
  // gmail.send — this app drafts only; the CSM still hits send manually.
  "https://www.googleapis.com/auth/gmail.compose",
];

/** Optional scope added later for alias auto-discovery. Has to be
 *  separately added to the OAuth consent screen by a project admin
 *  before users can grant it; otherwise Google returns
 *  `Error 400: invalid_scope` and the whole reconnect fails.
 *
 *  When `?minimal=1` is on the start URL we omit this so a CSM can
 *  reconnect via the core scopes even before the consent screen
 *  catches up. They'll just see "needs reconsent" hints on
 *  /settings/gmail until a full reconnect succeeds. */
const ALIAS_DISCOVERY_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.readonly";

export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      {
        error:
          "GOOGLE_CLIENT_ID is not set. Create an OAuth 2.0 Client in Google Cloud Console (Web application), add http://localhost:3000/api/auth/google/callback as an authorized redirect URI, then set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env.local.",
      },
      { status: 500 }
    );
  }
  const url = new URL(req.url);
  const redirect =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    `${url.origin}/api/auth/google/callback`;
  const next = url.searchParams.get("next") ?? "/settings/gmail";
  // `?minimal=1` drops the optional gmail.settings.readonly scope.
  // Used as a fallback when the Google Cloud project's OAuth consent
  // screen doesn't yet list that scope — Google would otherwise
  // reject the whole flow with Error 400: invalid_scope.
  const minimal = url.searchParams.get("minimal") === "1";
  const scopes = minimal
    ? CORE_SCOPES
    : [...CORE_SCOPES, ALIAS_DISCOVERY_SCOPE];

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirect);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  // Force consent so we always receive a refresh_token (Google only sends
  // one on first consent unless `prompt=consent` is set).
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", encodeURIComponent(next));

  return NextResponse.redirect(authUrl.toString());
}
