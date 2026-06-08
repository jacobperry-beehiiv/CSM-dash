"use client";

import { useEffect, useRef, useState } from "react";
import type { ColumnVisibilityState } from "@/lib/hooks/use-column-visibility";

/**
 * Small dropdown button that lets a user toggle column visibility on
 * a table. Pairs with `useColumnVisibility(tableKey, COLS)` — pass
 * the hook's return value through as `state`.
 *
 * The button trigger shows a "Columns (N hidden)" pill when any are
 * hidden so a user doesn't forget they've hidden something. Clicking
 * opens a panel with a checkbox per column.
 *
 * Closes on outside-click and Escape. No portal — positioning is
 * relative to the trigger.
 */
export function ColumnPicker({
  state,
  label = "Columns",
  align = "right",
}: {
  state: ColumnVisibilityState;
  /** Override the trigger label. Default "Columns". */
  label?: string;
  /** Which edge of the trigger the panel aligns to. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside-click / Escape to close. Standard popup pattern.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleable = state.columns.filter((c) => !c.required);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border bg-surface hover:bg-canvas text-fg"
        title="Toggle which columns are visible"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-3.5 h-3.5"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 6h16.5M3.75 12h16.5M3.75 18h16.5"
          />
        </svg>
        <span>{label}</span>
        {state.hiddenCount > 0 ? (
          <span className="inline-flex items-center justify-center min-w-[18px] px-1 py-px rounded text-[10px] font-mono bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
            {state.hiddenCount}
          </span>
        ) : null}
        <span aria-hidden className="text-subtle">
          ▾
        </span>
      </button>
      {open ? (
        <div
          className={`absolute z-30 mt-1 w-56 rounded-md border border-border bg-surface shadow-lg p-2 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <p className="text-[11px] uppercase tracking-wide text-muted px-2 pt-1 pb-2 font-semibold">
            Show columns
          </p>
          <ul className="space-y-0.5">
            {toggleable.map((c) => {
              const checked = state.isVisible(c.key);
              return (
                <li key={c.key}>
                  <label
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-canvas cursor-pointer"
                    onClick={(e) => {
                      // Prevent the label's default checkbox bounce —
                      // we drive state ourselves.
                      e.preventDefault();
                      state.toggle(c.key);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        /* handled by the label's onClick */
                      }}
                      className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                      aria-label={c.label}
                    />
                    <span className="text-fg">{c.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border mt-2 pt-2 px-1">
            <button
              type="button"
              onClick={() => {
                state.resetToDefault();
              }}
              className="text-[11px] text-accent hover:underline"
            >
              Reset to default
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
