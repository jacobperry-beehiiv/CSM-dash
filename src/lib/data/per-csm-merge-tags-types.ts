/**
 * Per-CSM custom merge tags — client-safe types.
 *
 * A CSM can register their own merge tags (name + text) that get
 * substituted into shared outreach templates at render time. Motivating
 * case: a "scheduling text" tag — each CSM has their own preferred
 * calendar-scheduling blurb (Calendly link, "grab time here" copy), so
 * a single shared template can say `{{scheduling_text}}` and the
 * outreach modal + bulk-drafts flow substitute the current CSM's
 * stored copy.
 *
 * Types live here (no server-only imports) so client components can
 * safely import them. Server-side kv reads/writes live in the sibling
 * per-csm-merge-tags.ts. Same split pattern as
 * personalization-types.ts / personalization.ts.
 */

export interface PerCsmMergeTag {
  /** Token portion — what goes between `{{ }}` in a template. Lowercase,
   *  alphanumeric plus underscore. Matches the regex the merge-tag
   *  interpolator uses for plain tokens: `[a-zA-Z0-9_.]+`. Cannot
   *  collide with a built-in tag; the store rejects those on save
   *  and the substitution path also ignores custom tags that would
   *  shadow a system tag (defensive — see merge-tags.ts). */
  name: string;
  /** Substitution value. Plain text — no HTML, no template syntax.
   *  Length-capped on save to keep KV rows small. */
  value: string;
}

export interface PerCsmMergeTagsEntry {
  /** The CSM's own custom tags. */
  tags: PerCsmMergeTag[];
  /** Set on save. */
  updated_by?: string;
  updated_at?: string;
}

/** Max characters per stored value. Templates paste this into email
 *  bodies so a couple thousand chars is plenty for a Calendly blurb
 *  or a signature block, and caps abuse. */
export const MAX_TAG_VALUE_LENGTH = 4000;

/** Max characters for a tag name. Kept short so bad names surface
 *  fast in the UI. */
export const MAX_TAG_NAME_LENGTH = 64;

/** Max distinct tags per CSM. Set high enough that no CSM should
 *  ever hit it in practice, but low enough that a runaway loop
 *  can't blow up a KV row. */
export const MAX_TAGS_PER_CSM = 50;

/** Whitelist for tag names — same alphabet the substitution regex
 *  accepts, minus `.` since dotted names conflict with the built-in
 *  `customer.*` namespace. Enforced on save. */
export const TAG_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

/** Returned by GET /api/settings/merge-tags so the settings page can
 *  show CSMs which tag names other CSMs are already using — helps
 *  keep conventions consistent across the team (a single scheduling
 *  text tag name, not five variants). */
export interface PerCsmMergeTagsResponse {
  /** Current viewer's tags. Empty array when none saved yet. */
  mine: PerCsmMergeTag[];
  /** Union of every tag name currently registered by any CSM, along
   *  with how many CSMs use it. Sorted by descending usage so the
   *  most conventional tags surface first. Does NOT include values —
   *  those are private to each CSM. */
  registered: Array<{ name: string; used_by_csm_count: number }>;
}
