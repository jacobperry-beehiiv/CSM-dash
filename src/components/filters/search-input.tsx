"use client";

/**
 * Shared search box used across every list view (customer, AM, future
 * tabs). One source of truth for placeholder styling, focus ring, and
 * grow-to-fill behavior inside a FilterBar row.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`px-3.5 py-2 bg-surface border border-border rounded-lg text-sm flex-1 min-w-[220px] text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent ${className}`}
    />
  );
}
