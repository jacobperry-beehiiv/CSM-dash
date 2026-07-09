import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";

/**
 * NextAuth (v5) gate for the dashboard. Google SSO restricted to the
 * @beehiiv.com domain — every page goes through the middleware which
 * forces an authenticated session before rendering.
 *
 * Scope intentionally stays at `openid email profile`. We DON'T request
 * gmail.compose here; that lives on the separate per-CSM Gmail OAuth flow
 * under /api/auth/google/* so users see "Sign in" once and then opt in to
 * draft creation later via /settings/gmail.
 *
 * ─── Preview-build auth bypass ───────────────────────────────────
 * Google OAuth doesn't support wildcards on redirect URIs and Vercel
 * mints a fresh domain per commit, so straight-through Google sign-in
 * on preview builds is a losing battle. When BOTH:
 *   • VERCEL_ENV === "preview" (set automatically on preview builds)
 *   • PREVIEW_AUTH_TOKEN is present in the environment
 * we mount a second Credentials provider that trades the shared token
 * for a stub session as PREVIEW_AUTH_EMAIL (falls back to Jacob's
 * beehiiv account so book-of-business filters resolve to a real book).
 *
 * The token gates access — set it in Vercel → Project → Settings →
 * Environment Variables, scoped to "Preview" only. Leave it OFF in
 * Production so this code path can't ever authenticate a prod visitor.
 */

const ALLOWED_DOMAIN = "@beehiiv.com";

/** True on Vercel preview builds AND when the shared token is set.
 *  Exported so /login can conditionally render the preview-login
 *  form only when the bypass is actually going to authenticate. */
export const previewAuthEnabled =
  process.env.VERCEL_ENV === "preview" &&
  Boolean(process.env.PREVIEW_AUTH_TOKEN);

const PREVIEW_STUB_EMAIL =
  process.env.PREVIEW_AUTH_EMAIL ?? "jacob.perry@beehiiv.com";

const previewProvider = previewAuthEnabled
  ? [
      Credentials({
        id: "preview",
        name: "Preview build",
        credentials: {
          token: { label: "Preview token", type: "password" },
        },
        async authorize(credentials) {
          const submitted =
            typeof credentials?.token === "string" ? credentials.token : "";
          if (!submitted) return null;
          if (submitted !== process.env.PREVIEW_AUTH_TOKEN) return null;
          return {
            id: `preview-${PREVIEW_STUB_EMAIL}`,
            email: PREVIEW_STUB_EMAIL,
            name: PREVIEW_STUB_EMAIL.split("@")[0].replace(/[._]/g, " "),
          };
        },
      }),
    ]
  : [];

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      // Reuses the GOOGLE_CLIENT_ID/SECRET that the per-CSM Gmail OAuth
      // flow also uses. AUTH_GOOGLE_ID/SECRET still work as overrides if
      // you ever want a separate sign-in client.
      clientId: process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID,
      clientSecret:
        process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: "openid email profile",
          // No `prompt: consent` — let Google skip the consent screen for
          // returning users on the same account.
        },
      },
    }),
    ...previewProvider,
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ profile, account }) {
      // Preview credentials provider — bypasses the beehiiv-domain
      // gate. authorize() already verified the shared token so the
      // stub user is trusted by construction.
      if (account?.provider === "preview") return true;
      const email = (profile?.email ?? "").toLowerCase();
      if (!email.endsWith(ALLOWED_DOMAIN)) {
        // NextAuth surfaces this as `?error=AccessDenied` on the sign-in page.
        return false;
      }
      return true;
    },
    async session({ session, token }) {
      // Surface a stable email on the session so client/server components can
      // read it without re-running the OAuth flow.
      if (session.user && typeof token.email === "string") {
        session.user.email = token.email;
      }
      return session;
    },
  },
  session: { strategy: "jwt" },
  trustHost: true,
});
