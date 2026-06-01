import { NextResponse } from "next/server";
import { saveToken } from "@/lib/data/gmail-token";
import { setActiveEmail } from "@/lib/data/active-user";
import { invalidateAliasCache } from "@/lib/integrations/gmail-aliases";

export const dynamic = "force-dynamic";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

interface IdTokenPayload {
  email?: string;
  email_verified?: boolean;
}

function decodeIdToken(idToken: string): IdTokenPayload | null {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json) as IdTokenPayload;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const next = state ? decodeURIComponent(state) : "/settings/gmail";

  if (errorParam) {
    return NextResponse.redirect(
      `${url.origin}${next}?gmail_error=${encodeURIComponent(errorParam)}`
    );
  }
  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 }
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing" },
      { status: 500 }
    );
  }
  const redirect =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    `${url.origin}/api/auth/google/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    return NextResponse.redirect(
      `${url.origin}${next}?gmail_error=${encodeURIComponent(
        `token_exchange_failed: ${txt.slice(0, 200)}`
      )}`
    );
  }
  const tok = (await tokenRes.json()) as TokenResponse;

  if (!tok.refresh_token) {
    return NextResponse.redirect(
      `${url.origin}${next}?gmail_error=${encodeURIComponent(
        "no_refresh_token — try revoking the existing grant at myaccount.google.com/permissions and connecting again"
      )}`
    );
  }

  const payload = tok.id_token ? decodeIdToken(tok.id_token) : null;
  const email = (payload?.email ?? "unknown@gmail").toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  await saveToken({
    email,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: now + tok.expires_in,
    scope: tok.scope,
    token_type: tok.token_type,
  });

  // Tag this browser as the user we just authed — drives downstream
  // /api/drafts/bulk-create and /api/auth/google/status calls.
  await setActiveEmail(email);

  // Drop any cached alias result for this account — the cache might
  // be holding a stale "needs_reconsent" error from before the user
  // granted the new scope. Without this, the settings page would
  // keep showing the reconnect prompt (or a stuck error) until the
  // 5-min TTL expired.
  invalidateAliasCache(email);

  return NextResponse.redirect(`${url.origin}${next}?gmail_connected=1`);
}
