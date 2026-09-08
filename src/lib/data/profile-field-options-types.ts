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

// ─── Display-time ordering ─────────────────────────────────────────

/**
 * Catch-all options that belong at the BOTTOM of every picker, in this
 * order, no matter where they'd fall alphabetically.
 *
 * They aren't platform names — they're the "none of the above" escape
 * hatches, so a CSM scanning for a real ESP shouldn't have to read past
 * "Homegrown" to reach "HubSpot". Matched case-insensitively so an
 * admin who typed "other" still gets the pin.
 */
const PINNED_LAST = ["homegrown", "other"];

/**
 * Sort an option list for DISPLAY: case-insensitive alphabetical, with
 * the PINNED_LAST catch-alls appended in their own fixed order.
 *
 * Called at each render site rather than baked into the stored lists,
 * and deliberately so: options are admin-managed through the Settings
 * editor, and an entry added there next month should slot into place on
 * its own instead of landing at the end of an order that was only
 * correct on the day someone re-sorted KV. It also keeps the stored
 * value exactly what an admin typed (same principle as
 * techStackChoices() being a read-time projection).
 *
 * `sensitivity: "base"` so casing and accents don't split otherwise
 * adjacent names ("kit" sorts next to "Kit", not after "Zapier").
 * Returns a new array; the input is left alone.
 */
export function sortProfileFieldOptions(options: string[]): string[] {
  const rank = (v: string) => {
    const i = PINNED_LAST.indexOf(v.trim().toLowerCase());
    // Non-pinned options all share rank -1, so they compare equal here
    // and fall through to the alphabetical tiebreak below.
    return i === -1 ? -1 : i;
  };
  return [...options].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) {
      // Either one is pinned and the other isn't (pinned goes last), or
      // both are pinned and PINNED_LAST order decides.
      if (ra === -1) return -1;
      if (rb === -1) return 1;
      return ra - rb;
    }
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
}
