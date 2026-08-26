import { kvGet, kvListPrefix, kvSet } from "../storage/kv";
import { isKnownTag } from "../templates/merge-tags";
import {
  MAX_TAG_NAME_LENGTH,
  MAX_TAG_VALUE_LENGTH,
  MAX_TAGS_PER_CSM,
  TAG_NAME_REGEX,
  type PerCsmMergeTag,
  type PerCsmMergeTagsEntry,
} from "./per-csm-merge-tags-types";

/**
 * Server-only store for per-CSM custom merge tags. Types live in
 * per-csm-merge-tags-types.ts so client components can import them
 * without pulling in KV → postgres → node/fs — same split pattern
 * as personalization.ts / personalization-types.ts.
 *
 * KV layout:
 *   csm:merge-tags:v1:<lowercased-email>  →  PerCsmMergeTagsEntry
 *
 * A read of "every tag name any CSM has registered" (used by the
 * settings page to nudge naming conventions) walks the KEY_PREFIX
 * via kvListPrefix. This is a small (dozens of rows) scan, fine.
 */

const KEY_PREFIX = "csm:merge-tags:v1:";

function keyFor(email: string): string {
  return `${KEY_PREFIX}${email.trim().toLowerCase()}`;
}

export async function loadPerCsmMergeTags(
  email: string | null | undefined
): Promise<PerCsmMergeTag[]> {
  if (!email) return [];
  const entry = await kvGet<PerCsmMergeTagsEntry>(keyFor(email));
  return entry?.tags ?? [];
}

/** Resolved lookup form used by the merge-tag interpolator — a plain
 *  name→value map. `applyMergeTags` reads this off `ctx.custom_tags`
 *  as a last-resort fallback after the built-in tag registry misses.
 *  Convenience wrapper around loadPerCsmMergeTags. */
export async function loadPerCsmMergeTagsMap(
  email: string | null | undefined
): Promise<Record<string, string>> {
  const tags = await loadPerCsmMergeTags(email);
  const out: Record<string, string> = {};
  for (const t of tags) out[t.name] = t.value;
  return out;
}

export async function savePerCsmMergeTags(
  email: string,
  next: PerCsmMergeTag[]
): Promise<PerCsmMergeTag[]> {
  const sanitized = sanitizeTags(next);
  const entry: PerCsmMergeTagsEntry = {
    tags: sanitized,
    updated_by: email.trim().toLowerCase(),
    updated_at: new Date().toISOString(),
  };
  await kvSet<PerCsmMergeTagsEntry>(keyFor(email), entry);
  return sanitized;
}

/** Sanitize + validate a user-submitted list of tags. Drops entries
 *  that fail validation rather than throwing so a settings-page
 *  save doesn't hard-fail on one bad row — the sanitized result is
 *  round-tripped to the UI, so any silent drops are visible. */
function sanitizeTags(raw: PerCsmMergeTag[]): PerCsmMergeTag[] {
  const seen = new Set<string>();
  const out: PerCsmMergeTag[] = [];
  for (const t of raw) {
    if (!t || typeof t.name !== "string" || typeof t.value !== "string") continue;
    const name = t.name.trim();
    if (name.length === 0 || name.length > MAX_TAG_NAME_LENGTH) continue;
    if (!TAG_NAME_REGEX.test(name)) continue;
    // Never allow overriding a system tag — the substitution path is
    // defensive too, but rejecting on save keeps the settings page
    // honest ("this name is reserved").
    if (isKnownTag(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const value = t.value.slice(0, MAX_TAG_VALUE_LENGTH);
    out.push({ name, value });
    if (out.length >= MAX_TAGS_PER_CSM) break;
  }
  return out;
}

/** List every tag name registered by any CSM, along with how many
 *  CSMs have registered it. Used by /settings/merge-tags to nudge
 *  naming conventions (e.g. everyone should use `scheduling_text`,
 *  not `calendly` / `book_meeting` / `time_slot`). */
export async function listRegisteredTagNames(): Promise<
  Array<{ name: string; used_by_csm_count: number }>
> {
  const keys = await kvListPrefix(KEY_PREFIX);
  // Also match the file-backend sanitized form. fileFor() replaces `:`
  // with `_`, so a local dev key comes back as `csm_merge-tags_v1_<email>`.
  const sanitizedFilePrefix = KEY_PREFIX.replace(/[^a-z0-9._/-]/gi, "_");
  const relevant = keys.filter(
    (k) => k.startsWith(KEY_PREFIX) || k.startsWith(sanitizedFilePrefix)
  );
  const counts = new Map<string, number>();
  await Promise.all(
    relevant.map(async (k) => {
      const entry = await kvGet<PerCsmMergeTagsEntry>(k);
      if (!entry?.tags) return;
      for (const t of entry.tags) {
        counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
      }
    })
  );
  return Array.from(counts.entries())
    .map(([name, used_by_csm_count]) => ({ name, used_by_csm_count }))
    .sort(
      (a, b) =>
        b.used_by_csm_count - a.used_by_csm_count || a.name.localeCompare(b.name)
    );
}
