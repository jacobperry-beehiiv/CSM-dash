"use client";

import { useEffect, useRef, useState } from "react";

export interface MultiSelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional count rendered right-aligned after the label. */
  count?: number;
}

/**
 * Single-control multi-select filter: a SelectFilter-styled trigger that
 * opens a checklist panel. Pick several values; the trigger shows how
 * many are selected and each row keeps its per-option count. Closes on
 * outside-click / Escape (same popup mechanics as ColumnPicker).
 *
 * State is owned by the caller (a Set + onToggle), so the caller decides
 * how selections persist — e.g. URL-synced via a comma-joined param.
 */
export function MultiSelectFilter<T extends string = string>({
  label,
  options,
  selected,
  onToggle,
  onClear,
  emptyLabel = "All",
  disableZeroCounts = true,
  className,
}: {
  label?: string;
  options: MultiSelectOption<T>[];
  selected: Set<T>;
  onToggle: (value: T) => void;
  /** Shown as a "Clear selection" link when anything is selected. */
  onClear?: () => void;
  /** Trigger text when nothing is selected. */
  emptyLabel?: string;
  /** When true, options with count 0 render disabled (unless already
   *  selected, so a stale pick can still be removed). */
  disableZeroCounts?: boolean;
  /** Extra classes for the trigger button — e.g. a fixed width so it
   *  lines up with a sibling SelectFilter. */
  className?: string;
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

  const count = selected.size;
  const summary = count === 0 ? emptyLabel : `${count} selected`;

  return (
    <div
      ref={rootRef}
      className="relative inline-flex items-center gap-2 text-xs text-muted"
    >
      {label ? <span>{label}:</span> : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-2 py-1 border border-border-strong rounded-md text-sm bg-surface hover:bg-canvas text-fg ${
          className ?? ""
        }`}
      >
        <span>{summary}</span>
        <span aria-hidden className="text-subtle">
          ▾
        </span>
      </button>
      {open ? (
        <div className="absolute z-30 top-full left-0 mt-1 w-56 rounded-md border border-border bg-surface shadow-lg p-2">
          {options.length === 0 ? (
            <p className="text-xs text-subtle italic px-2 py-1">
              No options.
            </p>
          ) : (
            <ul className="space-y-0.5 max-h-64 overflow-y-auto">
              {options.map((o) => {
                const checked = selected.has(o.value);
                const dim = disableZeroCounts && o.count === 0 && !checked;
                return (
                  <li key={o.value}>
                    <label
                      className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded ${
                        dim
                          ? "opacity-50 cursor-not-allowed"
                          : "hover:bg-canvas cursor-pointer"
                      }`}
                      onClick={(e) => {
                        // Drive state ourselves — prevent the label's
                        // default checkbox bounce.
                        e.preventDefault();
                        if (dim) return;
                        onToggle(o.value);
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={dim}
                        onChange={() => {
                          /* handled by the label's onClick */
                        }}
                        className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                        aria-label={o.label}
                      />
                      <span className="text-fg flex-1 truncate" title={o.label}>
                        {o.label}
                      </span>
                      {o.count != null ? (
                        <span className="tabular-nums text-[11px] text-muted">
                          {o.count}
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {onClear && count > 0 ? (
            <div className="border-t border-border mt-2 pt-2 px-1">
              <button
                type="button"
                onClick={onClear}
                className="text-[11px] text-accent hover:underline"
              >
                Clear selection
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
