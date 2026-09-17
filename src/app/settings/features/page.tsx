import Link from "next/link";
import { auth } from "@/auth";
import {
  isFeatureEnabledFor,
  isFeatureUnrestricted,
} from "@/lib/auth/feature-flags";
import { isAdmin, isProfileOptionsAdmin } from "@/lib/auth/admin";
import {
  FEATURE_SETTINGS_LINKS,
  type FeatureId,
} from "@/lib/data/admin-flags-types";

export const dynamic = "force-dynamic";

/**
 * /settings/features — dark-launch hub for the settings surfaces
 * behind still-restricted feature flags. When a flag graduates to
 * unrestricted (via /admin/flags), the settings layout promotes its
 * entry into the primary sidebar and this hub drops the card. The
 * hub always retains admin-only entries (profile-fields option
 * lists, todo-automation) that aren't governed by a feature flag.
 *
 * Card labels + descriptions come from the shared
 * FEATURE_SETTINGS_LINKS registry so a promoted entry shows up in
 * the sidebar with the exact same copy it had in the hub — no
 * per-surface drift.
 */

interface FeatureCard {
  href: string;
  title: string;
  description: string;
  badge?: string;
}

/** Feature IDs the hub renders when the flag is still restricted.
 *  Ordering here is the card render order. */
const HUB_FEATURE_IDS: FeatureId[] = [
  "gmail-draft-labels",
  "customer-folders-sweep",
  "wins-opportunities",
  "upgrade-analysis",
  "sybill-ingest",
  "enterprise-requests",
  "lifecycle-board",
];

export default async function FeaturesSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;

  const cards: FeatureCard[] = [];
  for (const id of HUB_FEATURE_IDS) {
    const hasAccess = await isFeatureEnabledFor(id, email);
    if (!hasAccess) continue;
    // Flag has graduated → the sidebar owns the entry, hub skips it.
    if (await isFeatureUnrestricted(id)) continue;
    const link = FEATURE_SETTINGS_LINKS[id];
    if (!link) continue;
    cards.push({
      href: link.href,
      title: link.label,
      description: link.description,
      badge: link.badge,
    });
  }
  // Enterprise Request Loop has two admin queues under it. These
  // are dedicated deep-links to sub-pages, so they live only in the
  // hub — the sidebar-promoted top-level entry gets the reader to
  // the same queues via its own admin-queues section.
  if (
    (await isFeatureEnabledFor("enterprise-requests", email)) &&
    !(await isFeatureUnrestricted("enterprise-requests"))
  ) {
    cards.push({
      href: "/settings/enterprise-requests/unmatched",
      title: "Enterprise Request Loop — unmatched customers",
      description:
        "Admin queue: Linear customers that couldn't be resolved to a workspace on the nightly sync. Approve a match or skip the row.",
    });
    cards.push({
      href: "/settings/enterprise-requests/orphans",
      title: "Enterprise Request Loop — orphaned shipments",
      description:
        "Admin queue: shipped-channel hits (>14 days old) that never matched a snapshot row. Mark as live, not customer-facing, or leave pending.",
    });
  }
  if (isProfileOptionsAdmin(email)) {
    cards.push({
      href: "/settings/profile-fields",
      title: "Prior ESP & Tech Stack option lists",
      description:
        "Manage the shared option lists for the Prior ESP and Tech Stack account fields.",
    });
  }
  if (isAdmin(email)) {
    cards.push({
      href: "/settings/todo-automation",
      title: "Todo automation",
      description:
        "Phrasing + linked outreach template for every automated todo source (renewal milestones, Sybill recaps, etc.).",
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Feature settings
      </h1>
      <p className="text-sm text-muted mb-6 max-w-prose">
        Settings for dark-launched features — only the ones enabled
        for your account appear below. Features that have graduated
        to general availability move out of this hub and into the
        primary sidebar; look for them there.
      </p>

      {cards.length === 0 ? (
        <div className="text-sm text-muted italic">
          You don&rsquo;t currently have any dark-launched features
          enabled. Anything you had here that&rsquo;s now open to the
          full team lives in the main settings sidebar.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cards.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="block rounded-lg border border-border bg-surface p-4 hover:border-border-strong hover:bg-canvas/50"
            >
              <h2 className="font-semibold text-fg flex items-center gap-1.5">
                {c.title}
                {c.badge ? (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-accent/15 text-accent">
                    {c.badge}
                  </span>
                ) : null}
              </h2>
              <p className="text-xs text-muted mt-1">{c.description}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
