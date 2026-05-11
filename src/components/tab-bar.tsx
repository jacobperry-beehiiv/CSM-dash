"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

interface Tab {
  id: string;
  label: string;
}

interface Props {
  tabs: Tab[];
  defaultTab?: string;
  param?: string;
}

export function TabBar({ tabs, defaultTab, param = "tab" }: Props) {
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
    <div className="border-b border-border mb-6 flex gap-1 overflow-x-auto">
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
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
