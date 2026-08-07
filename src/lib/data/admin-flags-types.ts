/**
 * Pure type/constant module — safe to import from client components.
 * Server-side store implementation (KV reads/writes) lives in
 * admin-flags.ts.
 *
 * Same split pattern as settings-types.ts / settings.ts and
 * personalization-types.ts / personalization.ts.
 */

/** Stable IDs for every flag we can toggle from the Super Admin
 *  panel. Adding a new flag = append here + extend the UI in
 *  /admin/flags/page.tsx + read it via `isFeatureEnabledFor` at the
 *  feature's gate point. */
export type FeatureId =
  | "personalization"
  | "gmail-draft-labels"
  | "customer-folders-sweep"
  | "sybill-ingest"
  | "wins-opportunities"
  | "upgrade-analysis";

/** Per-feature gate state. Defaults to "unrestricted" — everyone who
 *  passes the feature's own eligibility check (e.g. CSM with Gmail
 *  for personalization) gets the feature. Flip `restricted` on and
 *  populate `allowed_emails` to scope it to a specific list. An
 *  empty `allowed_emails` array WITH `restricted: true` means
 *  "nobody," which is the kill-switch state. */
export interface FeatureGate {
  restricted: boolean;
  allowed_emails: string[];
}

/** Full admin-flags KV row. One entry per FeatureId. */
export interface AdminFlags {
  features: Record<FeatureId, FeatureGate>;
}

/** Human-friendly metadata used to render the /admin/flags UI without
 *  hardcoding labels in the JSX. */
export interface FeatureMetadata {
  id: FeatureId;
  label: string;
  description: string;
  /** Note about how the gate interacts with the feature's own
   *  eligibility check (if any). Surfaced in the UI so an admin
   *  doesn't accidentally assume "unrestricted = on for everyone
   *  including non-CSMs." */
  eligibility_note?: string;
}

export const FEATURE_METADATA: ReadonlyArray<FeatureMetadata> = [
  {
    id: "personalization",
    label: "Dashboard personalization",
    description:
      "Custom dashboard name, accent color, font, and logo. Lives at /settings/personalize.",
    eligibility_note:
      "Even when unrestricted, only CSMs with Gmail connected can personalize. Restricting narrows further to the listed emails.",
  },
  {
    id: "gmail-draft-labels",
    label: "Gmail customer labels on drafts",
    description:
      "Auto-apply each CSM's existing Gmail customer label to bulk drafts the dashboard creates. Configurable at /settings/gmail-labels.",
    eligibility_note:
      "Requires the gmail.modify scope. Users who haven't re-consented after the scope upgrade see a banner and unlabeled drafts until they re-auth.",
  },
  {
    id: "customer-folders-sweep",
    label: "Drive → HubSpot customer-folder sweep",
    description:
      "Scans the shared Drive parent folder, fuzzy-matches child folders to customers, and (after admin review) writes the folder URL into HubSpot's customer_folder property. Lives at /settings/customer-folders.",
    eligibility_note:
      "Uses the acting CSM's Drive token (drive.readonly). Only fills BLANK customer_folder fields — existing values are always preserved.",
  },
  {
    id: "sybill-ingest",
    label: "Sybill action-item ingest",
    description:
      "Pulls call-recap action items from each CSM's Gmail (sender: @sybill.ai) and creates personal to-dos. Manual sync only — button lives at /settings/sybill.",
    eligibility_note:
      "Requires the existing gmail.readonly scope (already granted). The sweep only walks the viewer's own inbox; no cross-CSM lookups.",
  },
  {
    id: "wins-opportunities",
    label: "Wins & Opportunities dashboard tab",
    description:
      "Detects overlooked customer wins (verified CTOR records, open streaks, quality growth, deliverability streaks) via a daily cron, cross-checks against at-risk flags to suppress celebrations of struggling accounts, and surfaces the read-only list on /csm?tab=wins.",
    eligibility_note:
      "Detection endpoint honors the same allowlist — the daily cron will skip work for CSMs whose accounts aren't visible to any user with the flag on.",
  },
  {
    id: "upgrade-analysis",
    label: "D&C Upgrade Analysis",
    description:
      "On-demand scorecard that pulls the six D&C Upgrade Analysis pillars (identity, acquisition, funnel, engagement, provider, network) from Metabase/ClickHouse and scores them against the tunable threshold registry. Primary use case: AMs pitching upgrades to Growth-tier customers can run the analysis first and see whether D&C needs to be looped in.",
    eligibility_note:
      "Endpoint is session-auth only (no cron in v1). ClickHouse/Postgres queries are relatively expensive — the 24h freshness guard prevents accidental repeat-scans.",
  },
];

/** Safe defaults — every feature ships unrestricted. New flags
 *  added here MUST get a default entry so existing installs don't
 *  go dark on rollout. */
export const DEFAULT_FLAGS: AdminFlags = {
  features: {
    personalization: { restricted: false, allowed_emails: [] },
    // Ships dark — only Jacob sees the settings page + gets labeled
    // drafts until /admin/flags flips this to unrestricted.
    "gmail-draft-labels": {
      restricted: true,
      allowed_emails: ["jacob.perry@beehiiv.com"],
    },
    // Ships dark — one-off review + backfill tool. Admins run the
    // sweep, approve matches, and apply. Flip via /admin/flags once
    // the initial backfill's done if the sweep becomes a routine.
    "customer-folders-sweep": {
      restricted: true,
      allowed_emails: ["jacob.perry@beehiiv.com"],
    },
    // Ships dark — manual button. Flip via /admin/flags once the
    // parser holds up on real Sybill mail across CSMs.
    "sybill-ingest": {
      restricted: true,
      allowed_emails: ["jacob.perry@beehiiv.com"],
    },
    // Ships dark — Phase 1 (detection + suppression + read-only list).
    // Validate detection quality on Jacob's book before opening to
    // Hayden or the wider Enterprise CSM team.
    "wins-opportunities": {
      restricted: true,
      allowed_emails: ["jacob.perry@beehiiv.com"],
    },
    // Ships dark — PR 1 shipping just the engine + manual scan
    // endpoint. Validate the scorecard against 10 D&C-decided cases
    // before opening to AMs; UI + Slack search integration land in
    // PR 2/3 and expand the allowlist.
    "upgrade-analysis": {
      restricted: true,
      allowed_emails: ["jacob.perry@beehiiv.com"],
    },
  },
};

/** Apply allow-list semantics. Returns true when:
 *   - The feature is unrestricted (default), OR
 *   - The user's email is in `allowed_emails`.
 *  Returns false when restricted + the email isn't listed.
 *
 *  Defensive: an unknown FeatureId reads as false, since absence in
 *  the flag map probably means a stale client checking a flag the
 *  server hasn't shipped yet.
 */
export function applyGate(
  flags: AdminFlags | null | undefined,
  featureId: FeatureId,
  email: string | null | undefined
): boolean {
  if (!email) return false;
  // Fall back to the entire DEFAULT_FLAGS gate when KV has no entry —
  // not just the `restricted` flag — so a flag defaulted to
  // `{restricted: true, allowed_emails: [...]}` still honors its
  // allowlist before any admin writes anything to KV. (Previously
  // the fallback only checked `restricted`, so a default-allowlisted
  // user couldn't see their own feature until an admin saved the
  // flags page.)
  const gate = flags?.features?.[featureId] ?? DEFAULT_FLAGS.features[featureId];
  if (!gate) return false;
  if (!gate.restricted) return true;
  const target = email.trim().toLowerCase();
  return gate.allowed_emails.some((e) => e.trim().toLowerCase() === target);
}
