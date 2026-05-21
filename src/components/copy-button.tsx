"use client";

import { useState } from "react";

/**
 * Tiny client-only button that copies a fixed value to the clipboard
 * and flashes a "Copied" confirmation. Lives in its own file so
 * server components (like CustomerDetailPanel) can drop it inline
 * without flipping their own "use client" boundary.
 *
 * Renders the value next to the button in a faint mono badge so the
 * user can eyeball it without copying — useful for short IDs like
 * `cus_…` or workspace UUIDs.
 */
export function CopyButton({
  value,
  label,
  showValue = true,
  className = "",
}: {
  value: string;
  /** Tooltip + aria-label. Defaults to "Copy". */
  label?: string;
  /** When true, renders the value itself in a mono badge next to the
   *  button. Set false for sensitive values you don't want surfaced. */
  showValue?: boolean;
  className?: string;
}) {
  const [hit, setHit] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setHit(true);
      setTimeout(() => setHit(false), 1200);
    } catch {
      /* clipboard blocked — silent; the value is still visible on screen */
    }
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {showValue ? (
        <code className="font-mono text-[11px] text-subtle bg-surface-2 px-1.5 py-0.5 rounded select-all">
          {value}
        </code>
      ) : null}
      <button
        type="button"
        onClick={copy}
        title={label ?? `Copy ${value}`}
        aria-label={label ?? "Copy"}
        className="px-2 py-0.5 text-[10px] uppercase tracking-wide border border-border-strong rounded-md hover:bg-canvas inline-flex items-center"
      >
        {hit ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
