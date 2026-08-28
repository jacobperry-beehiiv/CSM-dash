import { Suspense } from "react";
import { auth } from "@/auth";
import { SettingsSidebar } from "@/components/settings-sidebar";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { isAdmin, isProfileOptionsAdmin } from "@/lib/auth/admin";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  // Every flag-gated sub-page lives under one consolidated "Features"
  // sidebar entry so the sidebar doesn't grow one line per feature.
  // The Features hub page renders per-feature cards conditionally on
  // the viewer's eligibility (same visibility envelope as before).
  const extras: Array<{ href: string; label: string; description: string }> = [];
  const hasAnyFeatureAccess =
    (await isFeatureEnabledFor("gmail-draft-labels", email)) ||
    (await isFeatureEnabledFor("customer-folders-sweep", email)) ||
    (await isFeatureEnabledFor("wins-opportunities", email)) ||
    (await isFeatureEnabledFor("upgrade-analysis", email)) ||
    (await isFeatureEnabledFor("sybill-ingest", email)) ||
    isProfileOptionsAdmin(email) ||
    isAdmin(email);
  if (hasAnyFeatureAccess) {
    extras.push({
      href: "/settings/features",
      label: "Feature settings",
      description:
        "Hub for gated feature settings — Gmail labels, wins thresholds, D&C Upgrade Analysis, and more (only the ones enabled for you appear).",
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
