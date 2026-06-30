import { kvDelete, kvGet, kvSet } from "../storage/kv";

/**
 * Multi-tenant Gmail OAuth token store.
 *
 * Each CSM connects their own Google account; tokens are persisted via the
 * shared KV (file in dev, Postgres in prod) under `gmail-tokens`.
 * The browser cookie set on OAuth callback identifies which CSM is active,
 * so when they kick off a bulk draft the API loads their tokens and creates
 * drafts in their mailbox.
 */

export interface GmailToken {
  email: string;
  access_token: string;
  refresh_token: string;
  /** Unix epoch seconds. */
  expires_at: number;
  scope: string;
  token_type: string;
}

export type GmailTokenMap = Record<string, GmailToken>;

const KEY = "gmail-tokens";

let cache: GmailTokenMap | null = null;

export async function loadAllTokens(): Promise<GmailTokenMap> {
  if (cache) return cache;
  cache = (await kvGet<GmailTokenMap>(KEY)) ?? {};
  return cache;
}

export async function loadTokenFor(
  email: string | null | undefined
): Promise<GmailToken | null> {
  if (!email) return null;
  const all = await loadAllTokens();
  return all[email.toLowerCase()] ?? null;
}

async function persist(map: GmailTokenMap) {
  await kvSet(KEY, map);
  cache = map;
}

export async function saveToken(token: GmailToken): Promise<void> {
  const map = { ...(await loadAllTokens()) };
  map[token.email.toLowerCase()] = token;
  await persist(map);
}

export async function deleteToken(email: string): Promise<void> {
  const map = { ...(await loadAllTokens()) };
  delete map[email.toLowerCase()];
  if (Object.keys(map).length === 0) {
    await kvDelete(KEY);
    cache = {};
  } else {
    await persist(map);
  }
}

export async function listConnectedEmails(): Promise<string[]> {
  const all = await loadAllTokens();
  return Object.keys(all).sort();
}

/**
 * Returns true when the stored token for `email` carries the given
 * OAuth scope. Used to gate features that require a stricter scope
 * than `gmail.compose` (the original install) — `gmail.modify` for
 * label application on drafts, etc.
 *
 * Scope strings live as a space-separated list per Google's spec;
 * matched against the full URL form
 * (`https://www.googleapis.com/auth/gmail.modify`) so a partial
 * substring like "gmail.modify" inside another scope ID can't
 * false-positive.
 */
export async function hasGmailScope(
  email: string | null | undefined,
  scope: string
): Promise<boolean> {
  const token = await loadTokenFor(email ?? null);
  if (!token?.scope) return false;
  return token.scope.split(/\s+/).includes(scope);
}

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

/**
 * Returns a valid access token for the given email, refreshing via the
 * refresh_token if needed. Throws if the user isn't connected.
 */
export async function getValidAccessTokenFor(
  email: string
): Promise<string> {
  const token = await loadTokenFor(email);
  if (!token) {
    throw new Error(`Gmail not connected for ${email}.`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (token.expires_at - now > 60) return token.access_token;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing — can't refresh Gmail token."
    );
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as {
    access_token: string;
    expires_in: number;
    scope?: string;
    token_type?: string;
  };
  const next: GmailToken = {
    ...token,
    access_token: j.access_token,
    expires_at: now + j.expires_in,
    scope: j.scope ?? token.scope,
    token_type: j.token_type ?? token.token_type,
  };
  await saveToken(next);
  return next.access_token;
}
