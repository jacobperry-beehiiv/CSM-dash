import { Suspense } from "react";
import { auth } from "@/auth";
import { SettingsSidebar } from "@/components/settings-sidebar";
import {
  isFeatureEnabledFor,
  isFeatureUnrestricted,
} from "@/lib/auth/feature-flags";
import { isAdmin, isProfileOptionsAdmin } from "@/lib/auth/admin";
import {
  FEATURE_SETTINGS_LINKS,
  type FeatureId,
} from "@/lib/data/admin-flags-types";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  // Two-tier feature-settings surfacing:
  //   • Restricted (dark-launched to an allowlist) → the Features
  //     hub, one line for every gated card the viewer has access to.
  //   • Unrestricted (graduated to general availability) → promoted
  //     into the primary sidebar as its own top-level entry. Being
  //     in the sidebar is the visible signal that the feature has
  //     shipped for everyone.
  //
  // Layout does this promotion by checking each FeatureId's gate
  // state, and only pushes a features-hub entry when the viewer
  // still has at least one RESTRICTED gated feature to see.
  const extras: Array<{
    href: string;
    label: string;
    description: string;
    badge?: string;
  }> = [];

  const FLAG_IDS_WITH_SETTINGS: FeatureId[] = [
    "gmail-draft-labels",
    "customer-folders-sweep",
    "wins-opportunities",
    "upgrade-analysis",
    "sybill-ingest",
    "enterprise-requests",
    "lifecycle-board",
  ];
  let hasRestrictedAccess = false;
  for (const id of FLAG_IDS_WITH_SETTINGS) {
    const hasAccess = await isFeatureEnabledFor(id, email);
    if (!hasAccess) continue;
    const unrestricted = await isFeatureUnrestricted(id);
    const link = FEATURE_SETTINGS_LINKS[id];
    if (unrestricted && link) {
      // Graduated feature — promote to sidebar.
      extras.push(link);
    } else if (!unrestricted) {
      // Still gated — the Features hub carries it.
      hasRestrictedAccess = true;
    }
  }
  // Additional non-flag-driven accesses to the hub (profile-fields
  // options list + todo-automation for admins) — surface the hub
  // link when the viewer holds any of them even if no flag-gated
  // features are still restricted for them.
  const showFeaturesHub =
    hasRestrictedAccess || isProfileOptionsAdmin(email) || isAdmin(email);
  if (showFeaturesHub) {
    extras.push({
      href: "/settings/features",
      label: "Feature settings",
      description:
        "Hub for dark-launched features — Gmail labels, wins thresholds, D&C Upgrade Analysis, and more (only the ones enabled for you appear).",
    });
  }
  // Admin-only "Access allowlist" entry — promotes non-CSM emails to
  // CSM-team access (leads, sales engineers). Hidden from everyone
  // else's sidebar.
  if (isAdmin(email)) {
    extras.push({
      href: "/settings/access",
      label: "Access allowlist",
      description:
        "Emails to treat as CSM team members even when they don't have assigned customers.",
    });
  }
  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-fg tracking-tight">Settings</h1>
        <p className="text-sm text-muted mt-1">
          App-wide tunables — at-risk thresholds, outreach templates, and the
          Enterprise tier ladder.
        </p>
      </div>
      <div className="flex flex-col md:flex-row gap-6">
        <Suspense fallback={<div className="md:w-56 md:shrink-0" />}>
          <SettingsSidebar extras={extras} />
        </Suspense>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </>
  );
}
