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
export type FeatureId = "personalization" | "gmail-draft-labels";

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
