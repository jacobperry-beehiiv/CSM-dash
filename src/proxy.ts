import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * Gate every UI route behind NextAuth. Unauthenticated visitors get bounced
 * to /login. API routes used DURING the sign-in flow (everything under
 * /api/auth/*) are allowed through unauthenticated — without that exception,
 * the OAuth callback couldn't complete.
 *
 * Other /api/* endpoints stay protected.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Always allow NextAuth's own endpoints (sign-in, callback, session, csrf)
  // AND the per-CSM Gmail OAuth endpoints — those are gated by the dashboard
  // UI which is already inside the middleware, but the callback redirect
  // from Google needs to complete without a session check loop.
  if (pathname.startsWith("/api/auth/")) return;

  // The customer-signals route does its own auth (NextAuth session OR a
  // SIGNAL_API_KEY bearer token), so external integrations like the
  // CSM-dash Claude skill can POST/GET it without a logged-in session.
  // Without this exemption the proxy would redirect bearer-auth requests
  // to /login as HTML, breaking the JSON contract.
  if (pathname.startsWith("/api/customer-signals")) return;

  // The MCP route is bearer-token-only by design (per-user API tokens
  // minted at /settings/api-tokens). Same reason as customer-signals:
  // a JSON-RPC client expects a JSON response, not a 307 redirect to
  // an HTML login page.
  if (pathname.startsWith("/api/mcp")) return;

  // Cron-triggered Slack sync. Accepts EITHER a signed-in session
  // (admin clicking "Sync now") or a Bearer CRON_SECRET header
  // (Vercel Cron). The route handler itself checks both — letting the
  // request through here just keeps the JSON contract intact for the
  // cron path.
  if (pathname.startsWith("/api/feature-updates/sync")) return;

  // Same bearer/session dual-auth as above, but for the daily
  // team-task due-date reminder sweep. Triggered by GitHub Actions
  // cron (.github/workflows/team-task-reminders.yml).
  if (pathname.startsWith("/api/team-tasks/reminders/sweep")) return;

  // AM Proactive Outreach sweep — same dual-auth shape. Fires Slack
  // pings for newly-cap'd Enterprise accounts + 5-day nudges. Cron
  // workflow at .github/workflows/proactive-outreach-sweep.yml.
  if (pathname.startsWith("/api/proactive-outreach/sweep")) return;

  // AM Past Due history reconciliation — bumps episode counters and
  // closes episodes that have dropped out of q24620. Daily cron at
  // .github/workflows/past-due-history-sweep.yml.
  if (pathname.startsWith("/api/past-due/history/sweep")) return;

  // Daily per-CSM review digest. Dual session/bearer auth on the
  // route itself; bypass the proxy so the cron path returns JSON
  // instead of a 307 → /login.
  if (pathname.startsWith("/api/review-digest/sweep")) return;

  // Deliverability Slack sweep — same dual session/bearer auth on the
  // route. Without this bypass the GH Actions cron POSTs get 307'd to
  // /login and the workflow fails with HTTP 307 / exit 1.
  if (pathname.startsWith("/api/deliverability/sweep")) return;

  // Google News headlines sweep — same dual session/bearer auth. The
  // daily cron warms the per-workspace KV cache the homepage feed
  // reads from.
  if (pathname.startsWith("/api/news/sweep")) return;

  // Personal-todos sweep — same dual-auth shape. Activates scheduled
  // (future-dated) todos when their surface_at hits and fires the
  // 4-stage due-date reminder ladder. Cron at
  // .github/workflows/personal-todo-reminders.yml.
  if (pathname.startsWith("/api/personal-todos/sweep")) return;

  // Slack inbound webhook for the personal-todos feature: slash
  // command, DMs, reaction events. Slack signs every request with
  // HMAC-SHA256 and the URL-verification handshake echoes a challenge
  // back — the route does its own verification, so the proxy must
  // let Slack's POSTs through. The earlier 307-to-/login response is
  // what broke the URL-verification handshake on first setup.
  if (pathname.startsWith("/api/slack-webhook")) return;

  // Gmail-direct "Last contacted" lookup. Returns JSON to dashboard
  // pages on every render (via a batch POST) and to per-row refresh
  // buttons (via GET). Does its own session + Gmail-active-email
  // checks inside the route, so the proxy must let it through —
  // otherwise the batch POST gets 307'd to /login as HTML and the
  // client's JSON parser blows up.
  if (pathname.startsWith("/api/last-contact/gmail")) return;

  // Daily send-cadence refresh — same dual session/bearer auth on
  // the route (CRON_SECRET bearer OR signed-in CSM team member).
  // Without this bypass the GitHub Actions cron POSTs get 307'd to
  // /login before the bearer check can run. Feeds the per-customer
  // inferred_cadence_days KV overlay that Flag A's threshold reads
  // from. Cron at .github/workflows/cadence-refresh.yml.
  if (pathname.startsWith("/api/customers/refresh-cadence")) return;

  // Wins & Opportunities daily detection — same dual auth shape.
  // Without this bypass the cron POST gets 307'd and no candidate
  // wins ever get written to the csm:wins:v1 KV row. Cron at
  // .github/workflows/wins-detection.yml.
  if (pathname.startsWith("/api/wins/detect")) return;

  if (!req.auth) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // Authenticated — let the request through unchanged.
  return;
});

export const config = {
  // Skip static assets, the Next.js internals, favicons, and the public
  // sign-in page itself.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|login).*)",
  ],
};
