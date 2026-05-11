import NextAuth from "next-auth";
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
 */

const ALLOWED_DOMAIN = "@beehiiv.com";

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
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ profile }) {
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
