"use client";

import { useState } from "react";

/**
 * Reusable "section in an expanded customer panel" wrapper. Single
 * click-to-toggle header + body that collapses below it. Matches the
 * existing visual conventions (bg-surface, rounded-md border, uppercase
 * muted title) so dropping it into the detail panel doesn't change
 * the look — just the affordance.
 *
 * Use this in place of the older one-off Section helpers + the
 * standalone <h4> heads inside HubSpotContactsSection / FeatureUtilization
 * / AdGapSummary / Publications.
 *
 * State is per-instance; collapse choices reset when the panel is closed
 * and re-opened. (Persisting per-section across navigations could come
 * later if anyone asks — for now the cost > value.)
 */
export function CollapsibleSection({
  title,
  trailing,
  defaultOpen = false,
  children,
  className = "",
  bodyClassName = "",
}: {
  /** Title shown in the click-to-toggle header. */
  title: string;
  /** Optional extra content on the right of the header (counts,
   *  refresh button, etc.). Click events on this slot do NOT bubble
   *  to the toggle button. */
  trailing?: React.ReactNode;
  /** Initial open/closed state. Defaults to closed so the expanded
   *  customer panel reads as a clean stack of titles — click to open
   *  whichever section you actually need. */
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Extra classes on the body wrapper. Defaults to `p-3` for the
   *  common "padded card body" case; pass empty string when the body
   *  already controls its own padding. */
  bodyClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`bg-surface rounded-md border border-border ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-canvas/40 rounded-md"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className={`text-muted text-xs transition-transform inline-block ${
              open ? "rotate-90" : ""
            }`}
          >
            ▸
          </span>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted truncate">
            {title}
          </h4>
        </div>
        {trailing ? (
          <span
            // Stop propagation so e.g. a "Refresh" button in the
            // trailing slot doesn't accidentally toggle the section.
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 flex-shrink-0"
          >
            {trailing}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className={`border-t border-border ${
            bodyClassName === "" ? "" : bodyClassName || "p-4"
          }`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
