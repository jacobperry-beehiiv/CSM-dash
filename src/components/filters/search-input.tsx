"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shared search box used across every list view (customer, AM, future
 * tabs). One source of truth for placeholder styling, focus ring, and
 * grow-to-fill behavior inside a FilterBar row.
 *
 * Debounces `onChange` so typing stays responsive even when the parent
 * runs an expensive filter / writes to the URL on every commit. The
 * input value updates immediately (no perceived lag) but the parent
 * only sees the value `debounceMs` (default 250ms) after typing
 * stops. Pressing Enter commits instantly — useful when the user is
 * confident they've finished typing and wants the filter NOW.
 *
 * Why debounce here instead of inside every panel:
 *   • Every panel's filter pipeline runs on each keystroke today,
 *     and several do non-trivial work (publication-index lookup,
 *     bucket re-grouping, search-haystack rebuild per row, etc.).
 *   • Centralizing the delay means future search inputs inherit the
 *     behavior — no per-panel work needed.
 *   • Outside changes to `value` (URL navigation, clear button) still
 *     reflect immediately by syncing `draft` to `value` in an effect.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
  debounceMs = 250,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  /** Override the debounce delay. Set to 0 to disable (instant
   *  per-keystroke commit), useful for very small lists where the
   *  responsiveness wasn't an issue. */
  debounceMs?: number;
}) {
  // Local draft mirrors what the user is typing. The parent-visible
  // `value` lags by `debounceMs` to give the filter pipeline room
  // to breathe.
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External value changes (URL deep-link, clear button on parent,
  // CSM filter swap that resets `?q=`) need to overwrite the draft
  // — otherwise the in-progress typing would shadow the new value.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Clean up any pending debounce on unmount so a stale timer can't
  // fire onChange after the component is gone.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function scheduleCommit(next: string) {
    if (timer.current) clearTimeout(timer.current);
    if (debounceMs <= 0) {
      onChange(next);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      // Guard against the value already matching what the parent
      // holds — avoids redundant router.replace() / state churn
      // when the user types then erases the same chars.
      if (next !== value) onChange(next);
    }, debounceMs);
  }

  function commitNow(next: string) {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (next !== value) onChange(next);
  }

  return (
    <input
      type="search"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        scheduleCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        // Enter forces an immediate commit so a user who finished
        // typing and wants the filter NOW doesn't wait the full
        // 250ms. The blur path (clicking elsewhere) also commits via
        // onBlur below.
        if (e.key === "Enter") {
          e.preventDefault();
          commitNow(draft);
        }
      }}
      onBlur={() => commitNow(draft)}
      className={`px-3.5 py-2 bg-surface border border-border rounded-lg text-sm flex-1 min-w-[220px] text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent ${className}`}
    />
  );
}
