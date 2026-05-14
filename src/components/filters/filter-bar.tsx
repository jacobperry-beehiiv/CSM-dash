"use client";

import type { ReactNode } from "react";

/**
 * Visual shell that every page's filter strip lives inside. Pages compose
 * the actual controls (SearchInput, CsmSelector, SegmentToggle, …) as
 * children — this just enforces consistent margin / gap / alignment so
 * the filter row looks identical across tabs.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">{children}</div>
  );
}
