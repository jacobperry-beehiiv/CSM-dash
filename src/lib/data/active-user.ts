import { cookies } from "next/headers";

/**
 * Per-browser identity cookie. Set on Gmail OAuth callback so the API
 * routes can identify which CSM is making the request and route drafts
 * to the right mailbox.
 *
 * HttpOnly + SameSite=Lax — not readable from client JS. The /settings
 * /gmail page reads it via the /api/auth/google/status endpoint.
 */

export const ACTIVE_USER_COOKIE = "csm_active_email";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // ~1 year

export async function getActiveEmail(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_USER_COOKIE)?.value ?? null;
}

export async function setActiveEmail(email: string): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_USER_COOKIE, email.toLowerCase(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export async function clearActiveEmail(): Promise<void> {
  const store = await cookies();
  store.delete(ACTIVE_USER_COOKIE);
}
