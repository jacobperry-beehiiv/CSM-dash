"use client";

import { useState, type ReactNode } from "react";

/**
 * Collapsible filter drawer wrapper. Used for the deeper / lazy-loaded
 * filters (ad-network, feature utilization) so they share one consistent
 * "click row to expand" affordance instead of each rolling its own.
 *
 * The caller renders the actual inputs inside `children`; this just owns
 * the header, chevron, expanded-state animation, and "click anywhere on
 * the header to toggle" behavior.
 */
export function FilterPanel({
  title,
  trailing,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  children,
}: {
  title: string;
  /** Optional summary text / chip rendered on the right of the header (e.g. "3 active"). */
  trailing?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled-mode `open` state. When provided, the panel is fully controlled
   *  by the caller and the internal state is bypassed — useful when the
   *  surrounding component needs to react to expand (e.g. lazy-fetch on first
   *  open). Pair with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = openProp != null;
  const open = isControlled ? openProp : internalOpen;
  function toggle() {
    const next = !open;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }
  return (
    <div className="rounded-md border border-border bg-surface">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-canvas"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-fg">{title}</span>
        <span className="flex items-center gap-2">
          {trailing ? (
            <span className="text-xs text-muted">{trailing}</span>
          ) : null}
          <span
            className={`text-subtle transition-transform ${
              open ? "rotate-90" : ""
            }`}
            aria-hidden
          >
            ▸
          </span>
        </span>
      </button>
      {open ? (
        <div className="px-3 py-3 border-t border-border">{children}</div>
      ) : null}
    </div>
  );
}
