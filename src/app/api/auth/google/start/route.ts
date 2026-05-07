import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SCOPES = [
  "openid",
  "email",
  "profile",
  // Compose lets us create drafts. We deliberately do NOT request
  // gmail.send — this app drafts only; the CSM still hits send manually.
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

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

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirect);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  // Force consent so we always receive a refresh_token (Google only sends
  // one on first consent unless `prompt=consent` is set).
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", encodeURIComponent(next));

  return NextResponse.redirect(authUrl.toString());
}
