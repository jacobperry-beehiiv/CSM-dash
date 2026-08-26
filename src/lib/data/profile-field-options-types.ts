/**
 * Client-safe types + pure helpers for the shared "Prior ESP" /
 * "Tech Stack" option lists. Lives separate from
 * profile-field-options.ts (which imports the KV store) so client
 * components — the detail-panel editors, the /csm filter bar — can
 * import them without pulling Postgres + Node natives into the browser
 * bundle. Same split as field-mappings-types.ts.
 *
 * The store file re-exports everything here, so existing
 * `from "@/lib/data/profile-field-options"` imports keep working.
 */

export interface ProfileFieldOptions {
  priorEsp: string[];
  techStack: string[];
}

/**
 * The choice list for the Tech Stack field: its own options PLUS every
 * Prior ESP option.
 *
 * Why: customers routinely keep their old ESP running alongside beehiiv
 * (a migration that never finished, a second brand still on Mailchimp),
 * so a CSM tagging a tech stack needs the ESP names available. Prior ESP
 * and Tech Stack remain separate fields with separate stored values —
 * this only widens the *choices* offered for Tech Stack.
 *
 * Computed on the fly rather than merged into the stored list, and
 * deliberately so:
 *   - loadProfileFieldOptions() treats a saved-but-empty list as a
 *     real "cleared" state (distinct from never-saved). Folding the
 *     union in there would resurrect a list an admin had cleared.
 *   - The Settings editor would start showing ESP-owned entries inside
 *     the Tech Stack list, and once saved they'd be baked into KV —
 *     where deleting one just brings it back on the next read.
 * Keeping it a read-time projection means the two stored lists stay
 * exactly what an admin typed.
 *
 * Deduped case-insensitively with Tech Stack's own casing winning (it's
 * listed first), matching how the API canonicalises submitted values.
 */
export function techStackChoices(options: {
  priorEsp: string[];
  techStack: string[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...options.techStack, ...options.priorEsp]) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
