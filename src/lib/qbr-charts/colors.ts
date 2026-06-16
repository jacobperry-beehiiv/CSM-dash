/**
 * beehiiv palette for QBR Charts. Per Hayden's brief — purple-first,
 * with accent + supporting colors. Swap any hex if the canonical
 * brand book differs; this file is the single source of truth for
 * chart colors so the change flows through every chart at once.
 */

export const beehiiv = {
  purple: "#5A3FF6",
  purpleDeep: "#3A1FCC",
  purpleSoft: "#8B73FF",
  purplePale: "#E8E2FF",
  ink: "#0B0B12",
  slate: "#1A1B26",
  fog: "#F5F4FA",
  line: "#E5E4ED",
  muted: "#6B6B7B",
  accent: "#FF6B5C",
  gold: "#F5B82E",
  teal: "#22B8C0",
  green: "#3DD68C",
} as const;

/**
 * Ordered 10-color palette for multi-series charts. First entries
 * are the strong brand purples; latter slots fall through to the
 * accent colors. Series index → palette via `pickColor()`.
 */
export const seriesPalette: string[] = [
  beehiiv.purple,
  beehiiv.accent,
  beehiiv.teal,
  beehiiv.gold,
  beehiiv.green,
  beehiiv.purpleDeep,
  beehiiv.purpleSoft,
  beehiiv.slate,
  beehiiv.muted,
  beehiiv.purplePale,
];

/** Wraps via modulo so a chart with >10 series doesn't crash. Same
 *  series always gets the same color across re-renders. */
export function pickColor(index: number): string {
  return seriesPalette[index % seriesPalette.length];
}
