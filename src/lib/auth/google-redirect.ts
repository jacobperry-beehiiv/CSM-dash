/**
 * Resolve the `redirect_uri` for the Gmail/Drive OAuth flow.
 *
 * Shared by /api/auth/google/start and /api/auth/google/callback —
 * Google validates that the value sent at authorize time matches the
 * one sent at token-exchange time byte for byte, so the two routes
 * MUST compute it identically. That's why this lives in one place
 * instead of being inlined in both.
 *
 * Precedence, deliberately request-origin-first:
 *
 *   1. `x-forwarded-host` (+ `x-forwarded-proto`) — what Vercel sets
 *      to the domain the browser actually hit. Correct on custom
 *      aliases (jacob.normcsm.app) where `req.url` can otherwise be
 *      reconstructed from the internal deployment URL.
 *   2. `new URL(req.url).origin` — the plain path, correct locally
 *      and anywhere without a proxy in front.
 *   3. `GOOGLE_OAUTH_REDIRECT_URI` — last-resort pin.
 *
 * The env var used to be FIRST, which broke every preview alias: a
 * value pinned to the production callback meant a CSM connecting
 * Gmail from jacob.normcsm.app got bounced to csm-dash.vercel.app
 * after granting, landing the token on the wrong deployment. Demoting
 * it to a fallback means preview domains Just Work and the env var is
 * only needed if origin derivation somehow fails.
 *
 * Not a spoofing vector: whatever we compute here still has to be on
 * the OAuth client's Authorized redirect URIs allowlist in Google
 * Cloud, or Google rejects the request with redirect_uri_mismatch
 * before any code is issued. A forged `x-forwarded-host` can't
 * redirect an auth code anywhere that isn't already trusted.
 */

const CALLBACK_PATH = "/api/auth/google/callback";

/**
 * The public origin the browser actually reached us on. Also used for
 * the post-auth bounce back into the app — landing a CSM on the prod
 * origin after they connected Gmail from a preview alias is the same
 * bug in a different costume.
 */
export function resolveAppOrigin(req: Request): string | null {
  // Header values can be comma-joined when a request crosses several
  // proxies ("a.example, b.example"); the first entry is the original
  // client-facing host.
  const forwardedHost = req.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost) {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    return `${proto}://${forwardedHost}`;
  }

  try {
    const origin = new URL(req.url).origin;
    if (origin && origin !== "null") return origin;
  } catch {
    // Malformed req.url — caller falls back.
  }
  return null;
}

export function resolveGoogleRedirectUri(req: Request): string {
  const origin = resolveAppOrigin(req);
  if (origin) return `${origin}${CALLBACK_PATH}`;

  const pinned = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (pinned) return pinned;

  throw new Error(
    "Couldn't determine the OAuth redirect URI from the request, and GOOGLE_OAUTH_REDIRECT_URI isn't set."
  );
}
