"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS: Array<{ href: string; label: string; description: string }> = [
  {
    href: "/settings/general",
    label: "Flags & thresholds",
    description: "At-risk re-raise periods + table colorings.",
  },
  {
    href: "/settings/team",
    label: "Team",
    description: "Roster powering the open-asks tracker columns.",
  },
  {
    href: "/settings/templates",
    label: "Outreach templates",
    description: "Subjects, rich-text bodies, tags.",
  },
  {
    href: "/settings/tiers",
    label: "Enterprise tiers",
    description: "Subscriber-tier ladder + pricing.",
  },
  {
    href: "/settings/slack",
    label: "Slack",
    description: "Past-due channel, message template, CSM @-mentions.",
  },
  {
    href: "/settings/hubspot-fields",
    label: "HubSpot fields",
    description:
      "Map dashboard fields to HubSpot company properties + sync direction.",
  },
  {
    href: "/settings/gmail",
    label: "Gmail",
    description: "Connect Gmail to create bulk drafts without opening tabs.",
  },
  {
    href: "/settings/api-tokens",
    label: "API tokens",
    description:
      "Personal Bearer tokens for the customer-signals endpoint + future integrations.",
  },
  {
    href: "/settings/mcp",
    label: "MCP server",
    description:
      "Connect Claude Code or Claude Desktop to the dashboard.",
  },
  {
    href: "/settings/personalize",
    label: "Personalize",
    description:
      "Dashboard name, accent color, font, logo. CSMs with Gmail connected only.",
  },
  {
    href: "/settings/migration-warmup",
    label: "Migration warm-up",
    description:
      "Open-rate threshold, batch-size percentages, and the per-approach max-week caps the schedule generator uses.",
  },
  {
    href: "/settings/team-mascots",
    label: "Team mascots",
    description:
      "Upload pet photos for the header logo + to-do celebration rotation. Any CSM can add their own.",
  },
];

export function SettingsSidebar() {
  const pathname = usePathname();
  return (
    <aside className="md:w-56 md:shrink-0">
      <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
        {SECTIONS.map((s) => {
          const active = pathname.startsWith(s.href);
          return (
            <Link
              key={s.href}
              href={s.href}
              className={`block rounded-md px-3 py-2 text-sm whitespace-nowrap md:whitespace-normal transition-colors ${
                active
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:bg-surface-2"
              }`}
            >
              <div className="font-medium">{s.label}</div>
              <div
                className={`text-xs mt-0.5 hidden md:block ${
                  active ? "text-subtle" : "text-muted"
                }`}
              >
                {s.description}
              </div>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
