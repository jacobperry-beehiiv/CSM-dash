import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-user dashboard personalization.
 *
 * One entry per Gmail-connected CSM, keyed by their email. The
 * settings page at /settings/personalize writes this; the root
 * layout reads it on every render to inject CSS vars + override the
 * h1 / page title / logo.
 *
 * Gated by `isCsmWithGmail` — non-CSMs and CSMs without a connected
 * Gmail account fall back to defaults regardless of what's in KV
 * (so even if someone seeds a row directly, it doesn't apply until
 * they actually qualify).
 *
 * "Business Mode" is a session-only client-side toggle (localStorage)
 * and intentionally NOT persisted here — flipping back to defaults
 * for a screen share shouldn't survive across devices.
 */

const KEY_PREFIX = "csm:personalization:v1:";

export interface Personalization {
  /** Override for the dashboard h1 + browser tab title. Empty string
   *  → default ("CSM Mission Control"). Capped at 60 chars on save. */
  dashboard_name?: string;
  /** Hex color for `--accent`. Empty/invalid → default lavender. */
  accent_color?: string;
  /** Curated font key — see FONT_OPTIONS. Defaults to "default". */
  font_key?: FontKey;
  /** Optional public URL to a square-ish image used in place of the
   *  default beehiiv logo in the header. PNG/JPG/SVG. Browser does
   *  the load — we just stamp the URL. Empty → default. */
  logo_url?: string;
  /** When set, last modified by this email + at this ISO time. */
  updated_by?: string;
  updated_at?: string;
}

/** Curated font list — each maps to a Google Fonts family loaded in
 *  the root layout via <link>. Adding a new font here MUST also wire
 *  the load in src/app/layout.tsx. */
export const FONT_OPTIONS = [
  { key: "default", label: "Default (Satoshi)", family: "var(--font-satoshi)" },
  { key: "inter", label: "Inter", family: "'Inter', sans-serif" },
  { key: "outfit", label: "Outfit", family: "'Outfit', sans-serif" },
  {
    key: "space-grotesk",
    label: "Space Grotesk",
    family: "'Space Grotesk', sans-serif",
  },
  { key: "lora", label: "Lora (serif)", family: "'Lora', serif" },
  {
    key: "jetbrains-mono",
    label: "JetBrains Mono",
    family: "'JetBrains Mono', monospace",
  },
] as const;

export type FontKey = (typeof FONT_OPTIONS)[number]["key"];

export function fontFamilyFor(key: FontKey | undefined): string {
  const found = FONT_OPTIONS.find((f) => f.key === (key ?? "default"));
  return found?.family ?? FONT_OPTIONS[0].family;
}

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
