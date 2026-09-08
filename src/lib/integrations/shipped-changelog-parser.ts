/**
 * Parse #topic-product-changelog entries into structured records.
 *
 * The channel's fixed template (one message per shipped feature):
 *
 *   *Feature Name:* Custom Domains V3
 *   *Description:* Domain settings pages now support subdomain routing.
 *   *Resources/links:* https://linear.app/beehiiv/issue/BEE-24176
 *   *Location in app:* Settings → Domain
 *   *Plan Availability:* All
 *   *Product Manager:* Phil Mills
 *
 * When "Resources/links" carries a linear.app URL, that's an EXACT
 * match — the promotion engine can upgrade the row to Live with
 * high confidence. Otherwise we fall back to fuzzy matching on
 * feature name + description + location against the row's title +
 * project (tracked as `promotion_source: "changelog_fuzzy"` so a
 * skeptical CSM can see the softer match on the audit trail).
 *
 * The parser is intentionally forgiving about field capitalization
 * and the exact separator (colon vs em-dash) because CS ops
 * occasionally reformat manually. If a message doesn't contain a
 * *Feature Name:* line we return null — that's a non-changelog post
 * (e.g. a thread reply or an announcement).
 */

/** Match a `*Field Name:*` header followed by its value on the same
 *  line. Slack renders `*` as bold; the raw text preserves it. Value
 *  captured greedily to end-of-line. */
function fieldRe(name: string): RegExp {
  // Escape the field name for regex safety even though our known
  // set is ASCII-safe today.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\*${escaped}\\s*[:\\-]\\s*\\*?\\s*([^\\n]+)`, "i");
}

const FEATURE_NAME_RE = fieldRe("Feature Name");
const DESCRIPTION_RE = fieldRe("Description");
const RESOURCES_RE = fieldRe("Resources\\/links");
const LOCATION_RE = fieldRe("Location in app");
const PLAN_RE = fieldRe("Plan Availability");
const PM_RE = fieldRe("Product Manager");

/** linear.app URL matcher — reused across parsers. Kept local so
 *  each parser is standalone (no cross-dependency between them). */
const LINEAR_URL_RE =
  /(?:https?:\/\/)?linear\.app\/beehiiv\/issue\/([A-Z]+-\d+)/i;

export interface ChangelogHit {
  feature_name: string;
  description: string | null;
  location_in_app: string | null;
  plan_availability: string | null;
  product_manager: string | null;
  linear_key: string | null;
  resources_raw: string | null;
  ship_permalink: string | null;
  message_ts: string;
}

function extract(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/** Parse a single #topic-product-changelog message into a ChangelogHit,
 *  or return null when the message doesn't look like a changelog
 *  entry (missing the required Feature Name field). */
export function parseChangelogMessage(args: {
  text: string;
  message_ts: string;
  ship_permalink?: string | null;
}): ChangelogHit | null {
  const { text, message_ts, ship_permalink } = args;
  const feature_name = extract(FEATURE_NAME_RE, text);
  if (!feature_name) return null;
  const resources_raw = extract(RESOURCES_RE, text);
  let linear_key: string | null = null;
  if (resources_raw) {
    const m = LINEAR_URL_RE.exec(resources_raw);
    if (m) linear_key = m[1];
  }
  // Fallback — sometimes the Linear URL lands elsewhere in the
  // message body (e.g. inline in the Description). Only consult if
  // Resources/links didn't have it.
  if (!linear_key) {
    const m = LINEAR_URL_RE.exec(text);
    if (m) linear_key = m[1];
  }
  return {
    feature_name,
    description: extract(DESCRIPTION_RE, text),
    location_in_app: extract(LOCATION_RE, text),
    plan_availability: extract(PLAN_RE, text),
    product_manager: extract(PM_RE, text),
    linear_key,
    resources_raw,
    ship_permalink: ship_permalink ?? null,
    message_ts,
  };
}

/** Lowercase + strip non-alphanumerics for fuzzy string comparison.
 *  Deliberately simple — the changelog fallback is a hint, not a
 *  guarantee. When it misses, the request stays in "Live, possibly
 *  in beta" until an exact link match promotes it. */
export function normalizeForFuzzy(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Rough token-overlap score between two strings. Returns a value
 *  between 0 and 1. Not a proper NLP match — enough to flag "the
 *  changelog said 'Custom Domains V3' and the Linear title said
 *  'Custom Domain routing v3'" as a probable match without false-
 *  positiving on generic strings. */
export function fuzzyScore(a: string, b: string): number {
  const at = new Set(normalizeForFuzzy(a).split(/\s+/).filter(Boolean));
  const bt = new Set(normalizeForFuzzy(b).split(/\s+/).filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap += 1;
  return overlap / Math.max(at.size, bt.size);
}

/** Minimum score for a changelog_fuzzy promotion. Empirically 0.6
 *  catches meaningful reword variations (V3/v3, "the" dropping,
 *  punctuation differences) without matching generic titles like
 *  "New feature" against every message. */
export const FUZZY_MATCH_THRESHOLD = 0.6;
