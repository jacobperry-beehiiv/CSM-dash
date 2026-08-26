import { kvGet, kvSet } from "../storage/kv";
import type { ProfileFieldOptions } from "./profile-field-options-types";

// Re-exported so server callers can keep importing the type (and the
// Tech Stack union helper) from this module.
export type { ProfileFieldOptions };
export { techStackChoices } from "./profile-field-options-types";

/**
 * Shared, admin-managed option lists for the two per-customer profile
 * fields ("Prior ESP" + "Tech Stack"). Any CSM can *select* from these
 * on the account profile; only profile-options admins can add/remove
 * the available choices (gated in the Settings UI + the PUT route via
 * isProfileOptionsAdmin).
 *
 * Two bare KV rows — one per list — following the `csm:<feature>:v<n>`
 * convention. These are the *choices*, not per-customer values; the
 * per-customer selections live in the customer-overrides KV.
 */

const PRIOR_ESP_KEY = "csm:prior-esp-options:v1";
const TECH_STACK_KEY = "csm:tech-stack-options:v1";

/** Starter list of common newsletter platforms customers migrate from. */
export const DEFAULT_PRIOR_ESP_OPTIONS: string[] = [
  "Mailchimp",
  "Substack",
  "Sailthru",
  "ConvertKit / Kit",
  "Klaviyo",
  "HubSpot",
  "Campaign Monitor",
  "Ghost",
  "Marketo",
  "Beehiiv",
  "Flodesk",
  "ActiveCampaign",
];

/** Starter list of common tools that sit alongside beehiiv in a stack. */
export const DEFAULT_TECH_STACK_OPTIONS: string[] = [
  "WordPress",
  "Webflow",
  "Ghost",
  "Substack",
  "Patreon",
  "Shopify",
  "Squarespace",
  "Zapier",
  "Stripe",
  "Memberful",
  "Circle",
  "Discord",
];

/**
 * Normalize an option list: trim, collapse whitespace, drop empties,
 * and dedupe case-insensitively (keeping the first casing seen).
 *
 * Commas are stripped because the /csm "Tech Stack" filter encodes the
 * selected set as a comma-joined URL param — a comma inside an option
 * name would split it into two bogus values on read.
 */
function sanitize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const v = raw.replace(/,/g, " ").trim().replace(/\s+/g, " ");
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export async function loadProfileFieldOptions(): Promise<ProfileFieldOptions> {
  const [priorEsp, techStack] = await Promise.all([
    kvGet<string[]>(PRIOR_ESP_KEY),
    kvGet<string[]>(TECH_STACK_KEY),
  ]);
  // Fall back to the shipped defaults ONLY when a list has never been
  // saved (kvGet returns null). A saved-but-empty list is a deliberate
  // "cleared" state and is preserved as-is — otherwise an admin could
  // never remove all options (the defaults would resurrect on reload).
  return {
    priorEsp:
      priorEsp === null ? DEFAULT_PRIOR_ESP_OPTIONS : sanitize(priorEsp),
    techStack:
      techStack === null ? DEFAULT_TECH_STACK_OPTIONS : sanitize(techStack),
  };
}

/**
 * Persist one or both lists. Only the keys present in `patch` are
 * written, so the Settings editor can save a single list without
 * touching the other. Returns the merged, sanitized result.
 */
export async function saveProfileFieldOptions(
  patch: Partial<ProfileFieldOptions>
): Promise<ProfileFieldOptions> {
  const current = await loadProfileFieldOptions();
  const next: ProfileFieldOptions = { ...current };
  if (patch.priorEsp !== undefined) {
    next.priorEsp = sanitize(patch.priorEsp);
    await kvSet(PRIOR_ESP_KEY, next.priorEsp);
  }
  if (patch.techStack !== undefined) {
    next.techStack = sanitize(patch.techStack);
    await kvSet(TECH_STACK_KEY, next.techStack);
  }
  return next;
}
