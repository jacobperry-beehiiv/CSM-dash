/**
 * Live Ad Network Campaigns — client-safe types + pure helpers.
 *
 * Split from `ad-campaigns.ts` (which imports the Metabase client) so
 * the React view can `import type` without pulling a server-only
 * module into the bundle. Same pattern as
 * `enterprise-requests-types.ts` vs `enterprise-requests.ts`.
 */

/** One active campaign, normalized. Array fields are never null —
 *  the engine coerces Postgres NULLs to `[]` so the view can map
 *  without guarding every access. */
export interface AdCampaignRow {
  campaign_id: string;
  advertiser_id: string;
  advertiser: string;
  /** Advertiser tier as a STRING ("1".."4") — it's a varchar in
   *  Postgres, not an int. Null for advertisers with no tier set
   *  (e.g. The Feed as of 2026-09-25), so the view needs an
   *  "Untiered" bucket rather than assuming 1-4. */
  tier: string | null;
  campaign: string;
  payout_model: string | null;
  window_start_date: string | null;
  window_end_date: string | null;
  /** Flight hasn't begun yet. These are legitimately "active" — the
   *  brief keeps them and flags them rather than filtering them out. */
  not_started: boolean;
  /** Advertiser-level, auto-scored, top 5 by score. Present on every
   *  campaign as of 2026-09-25, which makes it the primary category
   *  axis — targeting tags and industry are both sparse. */
  content_tags: string[];
  targeting_tags: string[];
  industry_groups: string[];
  industries: string[];
  promoted_item: string | null;
  goal: string | null;
  geo: string[];
  cpc_cents: number | null;
  cpm_cents: number | null;
  clicks_goal: number | null;
  impressions_goal: number | null;
  /** Whole days from today to `window_end_date`. Null for always-on
   *  campaigns (no end date). Negative shouldn't occur — the query
   *  filters to `window_end_date >= now()` — but isn't guarded
   *  against, so the view should treat <= 0 as "ends today". */
  days_until_end: number | null;
}

export interface AdCampaignsReport {
  rows: AdCampaignRow[];
  fetched_at: string;
}

/** Campaigns ending within this many days get the "Ends in N days"
 *  flag and feed the summary tile. Per the brief. */
export const ENDING_SOON_DAYS = 5;

/**
 * Values that mean "the user never filled this in".
 *
 * `goal` and `promoted_item` are free-text columns paired with
 * `_other` variants; the SQL already coalesces those. What's left is
 * two sentinels the coalesce can't catch: an empty string, and the
 * literal "other" — which is what lands when someone picks Other from
 * the dropdown and leaves the companion text blank (Harmonic
 * Security, TLDR AI, TLDR Marketing all read `goal = "other"` as of
 * 2026-09-25). Rendering either verbatim shows a CSM a field that
 * looks populated and says nothing.
 */
const EMPTY_SENTINELS = new Set(["", "other", "n/a", "none", "tbd"]);

export function cleanText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (EMPTY_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** Postgres array → string[]. Handles null, and the `{a,b}` literal
 *  form in case a driver hands back the raw text representation
 *  rather than a parsed array. */
export function cleanArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
      .filter(Boolean);
  }
  if (typeof v === "string" && v.startsWith("{") && v.endsWith("}")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => s.replace(/^"|"$/g, "").trim())
      .filter(Boolean);
  }
  return [];
}

/** Cents → "$1.50". Null-safe; callers render "Rate not set" on null
 *  rather than "$0.00" per the brief's no-zeroes rule. */
export function formatCents(cents: number | null): string | null {
  if (cents == null || cents === 0) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Format a flight-window date in UTC.
 *
 * `window_start_date` / `window_end_date` are calendar dates, stored
 * as UTC midnight. The shared `fmtDate` renders in the viewer's local
 * zone, which turns 2026-09-23T00:00:00Z into "Sep 22" for anyone
 * west of UTC — every flight in the table read a day early in PT.
 *
 * Fixed here rather than in `fmtDate` on purpose: that helper is used
 * across the app for real instants (last send, last login) where
 * local rendering is correct. Only date-only columns want UTC, so the
 * narrower fix is the right one.
 */
export function formatFlightDate(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatTier(tier: string | null): string {
  return tier ? `Tier ${tier}` : "Untiered";
}

/** Whole days between now and an ISO date, floor'd. Calendar-ish —
 *  good enough for a 5-day "ending soon" badge and cheaper than
 *  pulling a date lib. */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms - Date.now()) / (24 * 60 * 60 * 1000));
}

// ─── Faceting ────────────────────────────────────────────────────────

export type FacetKey =
  | "content_tags"
  | "targeting_tags"
  | "industry_groups"
  | "tier"
  | "payout_model";

export interface FacetOption {
  value: string;
  /** How many of the currently-visible rows carry this value. Counts
   *  are computed against rows filtered by every OTHER group, so a
   *  chip's number is what you'd actually get by clicking it —
   *  counting against the fully-filtered set would show 0 next to
   *  every unselected chip in the same group. */
  count: number;
}

/** Pull a row's values for one facet as a string[], so selection and
 *  counting can treat scalar facets (tier, payout model) and array
 *  facets (tags, industries) identically. */
export function facetValues(row: AdCampaignRow, key: FacetKey): string[] {
  switch (key) {
    case "content_tags":
      return row.content_tags;
    case "targeting_tags":
      return row.targeting_tags;
    case "industry_groups":
      return row.industry_groups;
    case "tier":
      return [formatTier(row.tier)];
    case "payout_model":
      return row.payout_model ? [row.payout_model.toUpperCase()] : [];
  }
}

export type Selections = Record<FacetKey, string[]>;

export const EMPTY_SELECTIONS: Selections = {
  content_tags: [],
  targeting_tags: [],
  industry_groups: [],
  tier: [],
  payout_model: [],
};

/** OR within a group, AND across groups — per the brief. An empty
 *  group is a pass, not a reject. */
export function matchesSelections(
  row: AdCampaignRow,
  selections: Selections,
  /** Skip one group — used when counting a group's own chips. */
  except?: FacetKey
): boolean {
  for (const key of Object.keys(selections) as FacetKey[]) {
    if (key === except) continue;
    const chosen = selections[key];
    if (chosen.length === 0) continue;
    const values = facetValues(row, key);
    if (!chosen.some((c) => values.includes(c))) return false;
  }
  return true;
}

/** Free-text match across advertiser, campaign, goal, promoted item
 *  and every tag — the fields a CSM would plausibly search by. */
export function matchesSearch(row: AdCampaignRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.advertiser,
    row.campaign,
    row.goal ?? "",
    row.promoted_item ?? "",
    ...row.content_tags,
    ...row.targeting_tags,
    ...row.industries,
    ...row.industry_groups,
    ...row.geo,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * Chip options for one facet, counted against rows that pass every
 * OTHER filter group plus the search. That's what makes the numbers
 * mean "click this and you'll see N" — counting against the fully
 * filtered set would zero out every unselected chip in a group the
 * moment you selected one of its siblings.
 */
export function buildFacet(
  rows: AdCampaignRow[],
  key: FacetKey,
  selections: Selections,
  search: string
): FacetOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!matchesSearch(row, search)) continue;
    if (!matchesSelections(row, selections, key)) continue;
    for (const v of facetValues(row, key)) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface AdCampaignSummary {
  campaigns: number;
  advertisers: number;
  ending_soon: number;
  /** Mean CPC in cents across rows that HAVE one. Null when none of
   *  the visible rows set a rate — averaging over nulls as zero would
   *  quietly understate it. */
  avg_cpc_cents: number | null;
}

export function summarize(rows: AdCampaignRow[]): AdCampaignSummary {
  const advertisers = new Set<string>();
  let endingSoon = 0;
  let cpcSum = 0;
  let cpcCount = 0;
  for (const r of rows) {
    advertisers.add(r.advertiser_id);
    if (
      r.days_until_end != null &&
      r.days_until_end <= ENDING_SOON_DAYS &&
      !r.not_started
    ) {
      endingSoon += 1;
    }
    if (r.cpc_cents != null) {
      cpcSum += r.cpc_cents;
      cpcCount += 1;
    }
  }
  return {
    campaigns: rows.length,
    advertisers: advertisers.size,
    ending_soon: endingSoon,
    avg_cpc_cents: cpcCount > 0 ? Math.round(cpcSum / cpcCount) : null,
  };
}
