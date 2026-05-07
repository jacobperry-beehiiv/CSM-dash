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
    href: "/settings/gmail",
    label: "Gmail",
    description: "Connect Gmail to create bulk drafts without opening tabs.",
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
                  ? "bg-gray-900 text-white"
                  : "text-gray-700 hover:bg-gray-100"
              }`}
            >
              <div className="font-medium">{s.label}</div>
              <div
                className={`text-xs mt-0.5 hidden md:block ${
                  active ? "text-gray-300" : "text-gray-500"
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
