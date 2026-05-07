"use client";

import { useState } from "react";

interface Props {
  label: string;
  count: number;
  detail?: string;
  toneClass: string; // e.g. "bg-red-50 border-red-200 text-red-900"
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Collapsible bucket section used across AM dashboard tabs. Click the
 * header to expand/collapse. Defaults to open so the user sees data on
 * first paint; collapsed sections still show count + detail.
 */
export function BucketSection({
  label,
  count,
  detail,
  toneClass,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`border rounded-lg overflow-hidden ${toneClass}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-black/5 transition-colors text-left"
        aria-expanded={open}
      >
        <div className="flex items-baseline gap-3">
          <span
            className={`text-gray-700 transition-transform ${
              open ? "rotate-90" : ""
            }`}
            aria-hidden
          >
            ▸
          </span>
          <h3 className="font-semibold">{label}</h3>
          <span className="text-xs">
            {count} account{count === 1 ? "" : "s"}
            {detail ? ` · ${detail}` : ""}
          </span>
        </div>
      </button>
      {open ? <div className="bg-white">{children}</div> : null}
    </div>
  );
}
