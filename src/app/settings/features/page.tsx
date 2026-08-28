import Link from "next/link";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { isAdmin, isProfileOptionsAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

/**
 * /settings/features — consolidated hub for every settings surface
 * that lives behind a feature flag. Previously each flag-gated area
 * (gmail labels, customer folders, wins, upgrade analysis, todo
 * automation, profile field options, …) was its own sidebar entry
 * managed via the layout's `extras` array. The sidebar grew long
 * and made the dashboard's "settings" section feel bloated for
 * everyone even when most of the entries were dark for the viewer.
 *
 * This page renders one card per feature the current viewer is
 * eligible for, linking through to the specific page that already
 * exists. Non-eligible features aren't shown — same visibility
 * envelope as before, just one sidebar entry.
 */

interface FeatureCard {
  href: string;
  title: string;
  description: string;
}

export default async function FeaturesSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;

  const cards: FeatureCard[] = [];
  if (await isFeatureEnabledFor("gmail-draft-labels", email)) {
    cards.push({
      href: "/settings/gmail-labels",
      title: "Gmail customer labels",
      description:
        "Map each customer in your book to the Gmail label you already use, so dashboard drafts auto-tag in your inbox.",
    });
  }
  if (await isFeatureEnabledFor("customer-folders-sweep", email)) {
    cards.push({
      href: "/settings/customer-folders",
      title: "Customer folders sweep",
      description:
        "Scan the shared Drive parent, match folders to customers, and backfill HubSpot's customer_folder property.",
    });
  }
  if (await isFeatureEnabledFor("wins-opportunities", email)) {
    cards.push({
      href: "/settings/wins",
      title: "Wins detection thresholds",
      description:
        "Tune the per-rule thresholds the daily wins-detection engine scores against.",
    });
  }
  if (await isFeatureEnabledFor("upgrade-analysis", email)) {
    cards.push({
      href: "/settings/upgrade-analysis",
      title: "D&C Upgrade Analysis thresholds",
      description:
        "Tune the D&C Upgrade Analysis scorecard bands — complaint rates, deferral bands, engagement floors, escalation rules.",
    });
  }
  if (await isFeatureEnabledFor("sybill-ingest", email)) {
    cards.push({
      href: "/settings/sybill",
      title: "Sybill action-item ingest",
      description:
        "Manual sync button that pulls call-recap action items from Sybill emails in your Gmail into your personal to-do list.",
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
        Settings for gated features — only the ones enabled for your
        account appear below. Each card links through to that
        feature&rsquo;s own page.
      </p>

      {cards.length === 0 ? (
        <div className="text-sm text-muted italic">
          You don&rsquo;t currently have any gated features enabled.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cards.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="block rounded-lg border border-border bg-surface p-4 hover:border-border-strong hover:bg-canvas/50"
            >
              <h2 className="font-semibold text-fg">{c.title}</h2>
              <p className="text-xs text-muted mt-1">{c.description}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
