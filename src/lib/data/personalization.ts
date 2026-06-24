import { kvGet, kvSet } from "../storage/kv";
import {
  FONT_OPTIONS,
  type FontKey,
  type Personalization,
} from "./personalization-types";

/**
 * Server-only store for per-user dashboard personalization.
 *
 * Types + constants live in personalization-types.ts so client
 * components (settings page, provider) can import them without
 * pulling in the KV → postgres → fs/net/tls chain. Same split
 * pattern as settings-types.ts / settings.ts.
 *
 * "Business Mode" is intentionally NOT persisted here — it's a
 * client-side localStorage toggle so flipping back to defaults for
 * a screen share doesn't survive across devices.
 */

const KEY_PREFIX = "csm:personalization:v1:";

function keyFor(email: string): string {
  return `${KEY_PREFIX}${email.trim().toLowerCase()}`;
}

export async function loadPersonalization(
  email: string | null | undefined
): Promise<Personalization | null> {
  if (!email) return null;
  return (await kvGet<Personalization>(keyFor(email))) ?? null;
}

export async function savePersonalization(
  email: string,
  next: Personalization
): Promise<Personalization> {
  const sanitized: Personalization = {
    dashboard_name: (next.dashboard_name ?? "").trim().slice(0, 60) || undefined,
    accent_color: sanitizeHexColor(next.accent_color),
    font_key: sanitizeFontKey(next.font_key),
    logo_url: sanitizeHttpUrl(next.logo_url),
    updated_by: email.trim().toLowerCase(),
    updated_at: new Date().toISOString(),
  };
  await kvSet<Personalization>(keyFor(email), sanitized);
  return sanitized;
}

/** Accept `#rgb`, `#rrggbb` (any case). Anything else returns
 *  undefined so the layout falls back to the default. */
function sanitizeHexColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  return undefined;
}

function sanitizeFontKey(raw: FontKey | string | undefined): FontKey | undefined {
  if (!raw) return undefined;
  const found = FONT_OPTIONS.find((f) => f.key === raw);
  return found ? (found.key as FontKey) : undefined;
}

/** Whitelist http(s) URLs. Drops javascript:, data: blobs, relative
 *  paths — keeps the logo path safe to drop directly into an `<img
 *  src=…>`. Length-capped to keep KV rows small. */
function sanitizeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 2000) return undefined;
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.toString();
    }
  } catch {
    /* fall through */
  }
  return undefined;
}
