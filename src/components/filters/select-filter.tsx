"use client";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional count rendered after the label, e.g. "Monthly (42)". */
  count?: number;
}

/**
 * Labeled <select> dropdown used for single-pick filters (cadence,
 * interval, segment, future "owner" pickers). Matches the visual size
 * of CsmSelector so the FilterBar reads as one row.
 */
export function SelectFilter<T extends string = string>({
  label,
  value,
  onChange,
  options,
  emptyLabel = "All",
  emptyCount,
}: {
  label?: string;
  value: T | "";
  onChange: (value: T | "") => void;
  options: SelectOption<T>[];
  /** Text for the "no selection" option. Pass null to omit it (forces a pick). */
  emptyLabel?: string | null;
  /** Count to render next to the empty option, e.g. "All cadences (300)". */
  emptyCount?: number;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted">
      {label ? <span>{label}:</span> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T | "")}
        className="px-2 py-1 border border-border-strong rounded-md text-sm bg-surface"
      >
        {emptyLabel != null ? (
          <option value="">
            {emptyLabel}
            {emptyCount != null ? ` (${emptyCount})` : ""}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.count != null ? ` (${o.count})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
