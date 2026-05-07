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
    <div className="border-b border-gray-200 mb-4 flex gap-1 overflow-x-auto">
      {tabs.map((t) => {
        const active = current === t.id;
        return (
          <Link
            key={t.id}
            href={hrefFor(t.id)}
            scroll={false}
            className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
              active
                ? "border-gray-900 text-gray-900 font-medium"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
