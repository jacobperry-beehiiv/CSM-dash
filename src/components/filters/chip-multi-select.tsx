"use client";

import type { ReactNode } from "react";

export interface ChipOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional 1–2 character badge rendered before the label (e.g. flag code "A"). */
  badge?: string;
  /** Tailwind class string applied to the badge background/text. */
  badgeClass?: string;
  /** Tooltip text shown on hover. */
  description?: string;
}

/**
 * Multi-select chip strip used wherever the user picks several
 * categorical filters from a fixed set (at-risk flag codes, status,
 * engagement levels, …).
 *
 * Renders each option as a togglable chip with an optional count.
 * Options whose count is 0 are dimmed and disabled by default — this
 * prevents users from selecting filters that would produce zero rows.
 *
 * Sits inside an outer wrapper (caller provides the FilterBar / strip
 * row so combine-mode / clear buttons can sit beside the chips).
 */
export function ChipMultiSelect<T extends string = string>({
  options,
  selected,
  onToggle,
  countMap,
  disableZeroCounts = true,
}: {
  options: ChipOption<T>[];
  selected: Set<T>;
  onToggle: (value: T) => void;
  /** Map from value → count to render after each chip's label. */
  countMap?: Record<string, number>;
  /** When true, options whose count is 0 render disabled. */
  disableZeroCounts?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const checked = selected.has(o.value);
        const count = countMap?.[o.value];
        const dim = disableZeroCounts && count === 0;
        return (
          <button
            key={o.value}
            onClick={() => onToggle(o.value)}
            disabled={dim}
            title={o.description}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border transition-colors ${
              checked
                ? "bg-accent-soft border-accent text-fg font-medium"
                : dim
                  ? "bg-surface-2 border-border text-subtle cursor-not-allowed"
                  : "bg-surface border-border text-muted hover:text-fg hover:border-border-strong"
            }`}
          >
            {o.badge ? (
              <Badge dim={dim} className={o.badgeClass}>
                {o.badge}
              </Badge>
            ) : null}
            <span>{o.label}</span>
            {count != null ? (
              <span
                className={`tabular-nums text-[11px] ${
                  dim ? "text-subtle" : "text-muted"
                }`}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function Badge({
  children,
  className = "bg-surface-2",
  dim,
}: {
  children: ReactNode;
  className?: string;
  dim?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-semibold ${className} ${
        dim ? "opacity-50" : ""
      }`}
    >
      {children}
    </span>
  );
}
