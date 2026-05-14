"use client";

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  count?: number;
}

/**
 * Inline radio-style segment toggle. Mutually-exclusive options rendered
 * as connected buttons — visually identical to iOS segmented controls.
 *
 * Used for cohort filters (AM table: All / Approaching cap / Approaching
 * ent) and combine-mode toggles (at-risk: any / all).
 *
 * For very small toggles (any/all) pass `variant="compact"` to drop the
 * outer border and shrink padding.
 */
export function SegmentToggle<T extends string = string>({
  options,
  value,
  onChange,
  variant = "default",
  ariaLabel,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  variant?: "default" | "compact";
  ariaLabel?: string;
}) {
  const isCompact = variant === "compact";
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={
        isCompact
          ? "inline-flex rounded-md border border-border overflow-hidden text-xs"
          : "inline-flex flex-wrap gap-1"
      }
    >
      {options.map((o, i) => {
        const active = o.value === value;
        const compactCls = `px-2.5 py-1 ${
          active
            ? "bg-accent text-accent-fg font-medium"
            : "bg-surface text-muted hover:text-fg"
        } ${i > 0 ? "border-l border-border" : ""}`;
        const defaultCls = `px-3 py-2 rounded-lg text-sm font-medium border whitespace-nowrap ${
          active
            ? "bg-accent text-accent-fg border-gray-900"
            : "bg-surface text-muted border-border-strong hover:bg-canvas"
        }`;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={isCompact ? compactCls : defaultCls}
          >
            {o.label}
            {o.count != null ? (
              <span className="ml-1 tabular-nums opacity-80">({o.count})</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
