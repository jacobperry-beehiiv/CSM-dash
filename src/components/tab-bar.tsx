"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

interface Tab {
  id: string;
  label: string;
  /** Short pill text (e.g. "beta") rendered next to the label. */
  badge?: string;
}

interface Props {
  tabs: Tab[];
  defaultTab?: string;
  param?: string;
  /** Drops the container's bottom border + margin so the tab strip
   *  can sit inline as one element among others on a shared row
   *  (e.g. Lifecycle's Onboarding/Live sub-tabs next to the CSM
   *  selector) instead of owning its own full-width row. Each tab's
   *  own active-state underline is unaffected. */
  bare?: boolean;
}

export function TabBar({ tabs, defaultTab, param = "tab", bare = false }: Props) {
  const params = useSearchParams();
  const current = params.get(param) ?? defaultTab ?? tabs[0]?.id;

  function hrefFor(id: string): string {
    const next = new URLSearchParams(params.toString());
    if (id === defaultTab) next.delete(param);
    else next.set(param, id);
    const qs = next.toString();
    return qs ? `?${qs}` : "?";
  }

  return (
    // No overflow-x-auto here — with only a handful of tabs there's
    // nothing to scroll, and some browsers (notably Chromium-on-macOS
    // when classic scrollbars are enabled) reserve a vertical scrollbar
    // slot anyway, which made the tab strip look like it was wrapped
    // in an iframe. Wrap instead if a future page adds enough tabs to
    // overflow the viewport.
    <div
      className={`flex flex-wrap gap-1 ${
        bare ? "" : "border-b border-border mb-6"
      }`}
    >
      {tabs.map((t) => {
        const active = current === t.id;
        return (
          <Link
            key={t.id}
            href={hrefFor(t.id)}
            scroll={false}
            className={`px-3 py-2.5 text-sm border-b-2 -mb-px whitespace-nowrap transition-colors ${
              active
                ? "border-accent text-fg font-medium"
                : "border-transparent text-muted hover:text-fg"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              {t.label}
              {t.badge ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-accent/15 text-accent">
                  {t.badge}
                </span>
              ) : null}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
