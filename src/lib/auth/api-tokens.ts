import { createHash, randomBytes, randomUUID } from "node:crypto";
import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-user API tokens for the customer-signals endpoint (and any
 * future Bearer-auth integration). Each CSM mints their own token
 * via /settings/api-tokens; the skill on their machine carries that
 * token instead of the shared SIGNAL_API_KEY so every signal can be
 * attributed to the right person automatically.
 *
 * Security model:
 *   • Plaintext is generated server-side via crypto.randomBytes(32).
 *   • Only a SHA-256 hex digest is persisted. Plaintext is returned
 *     to the caller once at creation; never recoverable after that.
 *   • Lookups hash the incoming Bearer and compare against stored
 *     hashes — constant-time comparison via a Map lookup keyed by
 *     hash, so we never iterate the array per request after warm.
 *   • Tokens carry a `prefix` (first 12 chars of plaintext) for UI
 *     identification — enough to disambiguate at a glance, not enough
 *     to reconstruct the secret.
 *
 * Format: `csm_dash_<64-hex>` so it's distinguishable in logs and
 * grep'able if it accidentally lands in a screenshot.
 */

const KEY = "api-tokens:v1";
const TOKEN_PREFIX = "csm_dash_";
/** Number of leading chars to keep visible for UI identification. */
const VISIBLE_PREFIX_LEN = TOKEN_PREFIX.length + 4; // e.g. "csm_dash_3f8a"

export interface ApiToken {
  /** UUID for external reference — the UI revokes by this. */
  id: string;
  /** SHA-256 hex of the plaintext. The plaintext is unrecoverable. */
  hash: string;
  /** Owning CSM, lowercased. Drives `created_by` attribution on
   *  signals posted with this token. */
  user_email: string;
  /** Free-text label the user picked ("MacBook", "Claude skill"). */
  label: string;
  /** First N chars of the plaintext, for UI identification. Safe to
   *  display; the full token is unrecoverable from this prefix. */
  prefix: string;
  created_at: string;
  /** Set on every successful authenticated request that used this
   *  token. Useful for spotting stale tokens to revoke. */
  last_used_at?: string;
}

interface StorageShape {
  tokens: ApiToken[];
}

function hashOf(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

async function loadAll(): Promise<ApiToken[]> {
  const stored = await kvGet<StorageShape>(KEY);
  return stored?.tokens ?? [];
}

async function persistAll(tokens: ApiToken[]): Promise<void> {
  await kvSet<StorageShape>(KEY, { tokens });
}

/**
 * Generate a new token for the given user. Returns the plaintext —
 * caller must show it to the user once and never persist it.
 */
export async function createToken(
  userEmail: string,
  label: string
): Promise<{ plaintext: string; token: ApiToken }> {
  if (!userEmail) throw new Error("user_email is required");
  if (!label.trim()) throw new Error("label is required");
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString("hex");
  const token: ApiToken = {
    id: randomUUID(),
    hash: hashOf(plaintext),
    user_email: userEmail.toLowerCase(),
    label: label.trim(),
    prefix: plaintext.slice(0, VISIBLE_PREFIX_LEN),
    created_at: new Date().toISOString(),
  };
  const all = await loadAll();
  all.push(token);
  await persistAll(all);
  return { plaintext, token };
}

/** Return tokens belonging to one user (without the hash). */
export async function listTokensForUser(
  userEmail: string
): Promise<Omit<ApiToken, "hash">[]> {
  if (!userEmail) return [];
  const all = await loadAll();
  const lc = userEmail.toLowerCase();
  return all
    .filter((t) => t.user_email === lc)
    // strip the hash before returning anything to the client — the UI
    // never needs it and shipping it would slightly widen the attack
    // surface (e.g. cached responses, screenshots).
    .map(({ hash: _hash, ...rest }) => rest)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Look up a token by its plaintext value. Returns the owning user
 * email + token id on a hit, null otherwise. Side-effect: updates
 * `last_used_at` on a hit (fire-and-forget so the request path
 * stays fast).
 */
export async function findTokenOwner(
  plaintext: string
): Promise<{ user_email: string; token_id: string } | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const target = hashOf(plaintext);
  const all = await loadAll();
  const hit = all.find((t) => t.hash === target);
  if (!hit) return null;
  // Touch last_used_at — non-blocking; failure here is fine.
  void touchLastUsed(hit.id).catch(() => {});
  return { user_email: hit.user_email, token_id: hit.id };
}

async function touchLastUsed(tokenId: string): Promise<void> {
  const all = await loadAll();
  const hit = all.find((t) => t.id === tokenId);
  if (!hit) return;
  const now = new Date().toISOString();
  // Only bump if it would advance — avoids a write storm on rapid
  // re-auths within the same second.
  if (hit.last_used_at && hit.last_used_at >= now) return;
  hit.last_used_at = now;
  await persistAll(all);
}

/**
 * Revoke a token by id. Scoped to the requesting user so person A
 * can't nuke person B's tokens. Returns true if a token was deleted.
 */
export async function revokeToken(
  userEmail: string,
  tokenId: string
): Promise<boolean> {
  if (!userEmail || !tokenId) return false;
  const lc = userEmail.toLowerCase();
  const all = await loadAll();
  const next = all.filter(
    (t) => !(t.id === tokenId && t.user_email === lc)
  );
  if (next.length === all.length) return false;
  await persistAll(next);
  return true;
}
