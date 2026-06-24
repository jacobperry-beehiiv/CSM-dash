/**
 * Pure type/constant module — safe to import from client components.
 * No Node-only imports here. The server-side store implementation
 * (KV reads/writes, sanitizers) lives in personalization.ts —
 * keep that module out of client bundles.
 *
 * Same split pattern as settings-types.ts / settings.ts.
 */

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
