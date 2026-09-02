import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { loadSlackUserOAuthTokens } from "@/lib/data/slack-user-oauth-tokens";
import { redirect } from "next/navigation";
import Link from "next/link";

/**
 * /settings/slack/user-oauth
 *
 * Admin-only page to connect + inspect the Slack user token used by
 * the D&C Upgrade Analysis Slack search read. With rotation enabled
 * on the Slack app, the initial `xoxp-` / `xoxe-` pair is only ever
 * emitted through the OAuth callback — this page is the one-click
 * install flow that catches it and writes it to KV.
 *
 * Renders three cases:
 *   - Not connected → "Connect Slack workspace" button that starts
 *     the OAuth flow.
 *   - Connected → status card with team name, installed_by,
 *     scopes, and next expiry.
 *   - Error banner (via ?error=<slack error>) when the callback
 *     redirected back with a failure.
 */
export default async function SlackUserOAuthSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    installed?: string;
    error?: string;
    team_id?: string;
  }>;
}) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/");

  const params = await searchParams;
  const stored = await loadSlackUserOAuthTokens();

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Slack user token
        </h1>
        <p className="text-sm text-muted mt-1">
          Powers the Slack search on the D&amp;C Upgrade Analysis panel.
          Slack&rsquo;s <code>search.messages</code> endpoint requires a
          user token (<code>xoxp-…</code>) — bot tokens are rejected.
          With rotation enabled on our Slack app, the token pair lives
          in KV and refreshes itself automatically.
        </p>
      </div>

      {params.installed === "1" ? (
        <div className="rounded-md border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
          Connected. Slack search will start returning matches on the
          next D&amp;C scan.
        </div>
      ) : null}

      {params.error ? (
        <div className="rounded-md border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-900 dark:text-red-100">
          <div className="font-medium">Install failed: {params.error}</div>
          <div className="mt-1 text-[12px] opacity-90">
            {errorHint(params.error)}
          </div>
        </div>
      ) : null}

      {stored ? (
        <div className="rounded-md border border-border bg-surface p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-fg">
                Connected to {stored.team_name ?? stored.team_id}
              </div>
              <div className="text-[12px] text-muted mt-0.5">
                Installed by {stored.installed_by} on{" "}
                {new Date(stored.updated_at).toLocaleString()}
              </div>
            </div>
            <Link
              href="/api/slack/user-oauth/start"
              className="text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-canvas"
            >
              Reinstall
            </Link>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted">Slack user</dt>
            <dd className="text-fg font-mono">{stored.authed_user_id}</dd>
            <dt className="text-muted">Scopes</dt>
            <dd className="text-fg">{stored.scope || "(none reported)"}</dd>
            <dt className="text-muted">Access token expires</dt>
            <dd className="text-fg">
              {new Date(stored.expires_at).toLocaleString()} (auto-refresh)
            </dd>
          </dl>
        </div>
      ) : (
        <div className="rounded-md border border-border bg-surface p-4 space-y-3">
          <div className="text-sm text-fg">
            No Slack user token stored yet. Click Connect to install
            through Slack&rsquo;s OAuth flow — you&rsquo;ll be redirected
            to Slack, approve the <code>search:read</code> scopes for
            your account, and be sent back here.
          </div>
          <Link
            href="/api/slack/user-oauth/start"
            className="inline-block text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700"
          >
            Connect Slack workspace
          </Link>
        </div>
      )}

      <div className="text-[11px] text-muted">
        Requires <code>SLACK_CLIENT_ID</code> +{" "}
        <code>SLACK_CLIENT_SECRET</code> in the deployment env, and the
        callback URL{" "}
        <code>/api/slack/user-oauth/callback</code> registered under
        the Slack app&rsquo;s OAuth &amp; Permissions → Redirect URLs.
      </div>
    </div>
  );
}

function errorHint(err: string): string {
  switch (err) {
    case "rotation_not_enabled":
      return "Slack returned an install response without a refresh_token — token rotation isn't actually on. Enable it in the Slack app's Basic Information → App Credentials → Token Rotation, then reinstall.";
    case "state_mismatch":
      return "The install link was completed by a different admin than the one who started it. Start again yourself from this page.";
    case "missing_credentials":
      return "SLACK_CLIENT_ID / SLACK_CLIENT_SECRET aren't set on this deployment.";
    case "missing_code":
      return "Slack didn't include an authorization code in the redirect — usually caused by the admin canceling the consent screen.";
    case "invalid_state":
      return "The install link's state parameter was tampered with. Start again from this page.";
    default:
      return "Slack returned this error verbatim — check the app's OAuth & Permissions page to make sure the redirect URL is registered exactly and rotation is enabled.";
  }
}
