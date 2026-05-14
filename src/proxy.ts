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
