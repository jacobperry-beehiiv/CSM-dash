import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/slack/user-oauth/start
 *
 * Redirects the signed-in admin to Slack's authorize screen with the
 * user-token scopes we need for D&C search (`search.messages`). Slack
 * will bounce them to /api/slack/user-oauth/callback with a `?code=`
 * which the callback exchanges for the initial rotating token pair.
 *
 * The `state` param carries the admin's email so the callback can
 * stamp `installed_by` on the persisted row. It's short-lived (one
 * OAuth round-trip) so we just base64-encode; CSRF is out of scope
 * because Slack's own state → code binding + our email check on the
 * callback catches the "another user's redirect" case.
 *
 * Only admins can trigger — the resulting token belongs to whoever
 * approves the consent screen and inherits their Slack read access.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "SLACK_CLIENT_ID is not configured on this deployment." },
      { status: 500 }
    );
  }

  // Build the callback URL from the request's own origin so preview
  // deploys still work — Slack rejects any redirect_uri that isn't
  // pre-registered on the app's OAuth & Permissions page, so if
  // you're testing on a preview URL, register that one too. In
  // practice we install from production; the callback path is the
  // same across environments.
  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/slack/user-oauth/callback`;

  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", clientId);
  // No BOT scopes here — we already have the bot token from a
  // separate install. This flow only asks for USER scopes so the
  // resulting token is a `xoxp-` capable of search.messages.
  authorize.searchParams.set(
    "user_scope",
    "search:read.public,search:read.private"
  );
  authorize.searchParams.set("redirect_uri", redirectUri);
  // `state` isn't strictly required, but we use it to identify the
  // admin who initiated so we can verify + audit on the callback.
  authorize.searchParams.set(
    "state",
    Buffer.from(email, "utf8").toString("base64url")
  );

  return NextResponse.redirect(authorize.toString());
}
