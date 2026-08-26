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
  // Flag-gated nav entries are computed server-side so the sidebar
  // never renders a link the viewer can't reach.
  const extras: Array<{ href: string; label: string; description: string }> = [];
  if (await isFeatureEnabledFor("gmail-draft-labels", email)) {
    extras.push({
      href: "/settings/gmail-labels",
      label: "Gmail customer labels",
      description:
        "Map each customer in your book to the Gmail label you already use, so dashboard drafts auto-tag in your inbox.",
    });
  }
  if (await isFeatureEnabledFor("customer-folders-sweep", email)) {
    extras.push({
      href: "/settings/customer-folders",
      label: "Customer folders sweep",
      description:
        "Scan the shared Drive parent, match folders to customers, and backfill HubSpot's customer_folder property.",
    });
  }
  if (await isFeatureEnabledFor("wins-opportunities", email)) {
    extras.push({
      href: "/settings/wins",
      label: "Wins detection thresholds",
      description:
        "Tune the per-rule thresholds the daily wins-detection engine scores against. Overrides layer over shipped defaults; blank fields fall through.",
    });
  }
  // Admin-only: curate the shared Prior ESP / Tech Stack option lists.
  if (isProfileOptionsAdmin(email)) {
    extras.push({
      href: "/settings/profile-fields",
      label: "Prior ESP & Tech Stack",
      description:
        "Manage the shared option lists for the Prior ESP and Tech Stack account fields.",
    });
  }
  // Super-admin only: the automated-todo phrasing + action registry.
  // A wrong action binding fires on real customer outreach so we
  // stay in the tight admin allowlist here.
  if (isAdmin(email)) {
    extras.push({
      href: "/settings/todo-automation",
      label: "Todo automation",
      description:
        "Phrasing + linked outreach template for every automated todo source (renewal milestones, Sybill recaps, etc.).",
    });
  }
  if (await isFeatureEnabledFor("upgrade-analysis", email)) {
    extras.push({
      href: "/settings/upgrade-analysis",
      label: "Upgrade Analysis thresholds",
      description:
        "Tune the D&C Upgrade Analysis scorecard bands — complaint rates, deferral bands, engagement floors, escalation rules.",
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
