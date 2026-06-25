"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS: Array<{ href: string; label: string; description: string }> = [
  {
    href: "/admin/flags",
    label: "Feature flags",
    description:
      "Per-feature allow lists. Restrict personalization (and future features) to specific CSMs.",
  },
  {
    href: "/admin/team-todos",
    label: "Team to-dos",
    description: "Every CSM's personal to-do list — view, edit, audit.",
  },
  {
    href: "/admin/migration-warmup",
    label: "Migration warm-up",
    description:
      "Tune the open-rate threshold, approach multipliers, and safety bound that drive the generated schedule.",
  },
];

/** Sidebar nav for /admin/* — mirrors SettingsSidebar's pattern.
 *  Anything admin-only ships through here so the hardcoded
 *  ADMIN_NAV in the root layout stays a single entry pointing at
 *  /admin. */
export function AdminSidebar() {
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
                  : "text-fg hover:bg-canvas"
              }`}
            >
              <div className="font-medium">{s.label}</div>
              <div
                className={`text-[11px] mt-0.5 hidden md:block ${
                  active ? "text-accent-fg/80" : "text-muted"
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
