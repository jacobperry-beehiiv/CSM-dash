"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Generic per-table column visibility hook.
 *
 * Used by the at-risk table, customer table, and any future
 * column-heavy view that wants a "Columns ▾" toggle. State persists
 * in localStorage keyed by `tableKey` so a CSM's hide-set survives
 * navigation and reloads.
 *
 * Usage:
 *
 *   const COLS = [
 *     { key: "arr", label: "ARR" },
 *     { key: "last_send", label: "Last send" },
 *     { key: "recommended_action", label: "Recommended action", defaultVisible: false },
 *   ];
 *   const { isVisible, toggle, hiddenCount } = useColumnVisibility("at-risk", COLS);
 *   ...
 *   {isVisible("arr") ? <th>ARR</th> : null}
 *
 * Stable column keys are critical — they're persisted in
 * localStorage. Renaming a key effectively resets visibility for
 * everyone (it'll fall back to defaultVisible). Renaming the
 * `label` is safe.
 */

export interface ColumnDef {
  /** Stable identifier persisted in localStorage. */
  key: string;
  /** Human label shown in the picker dropdown. */
  label: string;
  /** Default visibility when no localStorage entry exists yet. */
  defaultVisible?: boolean;
  /** When true, the column is REQUIRED — it stays visible regardless
   *  of toggles and isn't shown as an option in the picker. Use for
   *  the Account / Actions columns that anchor the row. */
  required?: boolean;
}

export interface ColumnVisibilityState {
  /** Returns whether the given column should render. Required columns
   *  always return true. Unknown keys (typo / drift) return true so
   *  the column isn't silently hidden. */
  isVisible: (key: string) => boolean;
  /** Flip a single column's visibility. No-op on required columns. */
  toggle: (key: string) => void;
  /** Reset everyone back to defaults. */
  resetToDefault: () => void;
  /** The full column list as passed in (useful for the picker UI). */
  columns: ColumnDef[];
  /** How many non-required columns are currently hidden — drives the
   *  "Columns (3 hidden)" badge label on the trigger button. */
  hiddenCount: number;
}

function storageKey(tableKey: string): string {
  return `csm:table-columns:${tableKey}`;
}

function loadHidden(tableKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(tableKey));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function saveHidden(tableKey: string, hidden: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(tableKey),
      JSON.stringify(Array.from(hidden))
    );
  } catch {
    // localStorage quota / private mode — silently no-op; visibility
    // just won't persist across reloads.
  }
}

export function useColumnVisibility(
  tableKey: string,
  columns: ColumnDef[]
): ColumnVisibilityState {
  // Hidden set is the source of truth. A column is hidden iff its key
  // is in the set. Required columns ignore the set in isVisible().
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage AFTER mount to avoid SSR/CSR mismatch.
  // Until hydrated, every column renders (the default-render state) —
  // matching what the server emitted. Once hydrated, hidden columns
  // disappear. On first paint there can be a one-frame flash; the
  // tradeoff is no hydration warning.
  useEffect(() => {
    const loaded = loadHidden(tableKey);
    // Initialize defaults for columns where defaultVisible is false
    // BUT only if there's no existing localStorage entry for them.
    // Once a user has explicitly toggled (and we've persisted), the
    // user's choice always wins.
    const stored =
      typeof window !== "undefined"
        ? window.localStorage.getItem(storageKey(tableKey))
        : null;
    if (stored === null) {
      // First visit — seed from defaults.
      for (const c of columns) {
        if (c.defaultVisible === false && !c.required) {
          loaded.add(c.key);
        }
      }
      saveHidden(tableKey, loaded);
    }
    setHidden(loaded);
    setHydrated(true);
    // We deliberately only re-hydrate when the tableKey changes, not
    // when the columns array reference changes — callers often pass
    // a freshly-built array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);

  const requiredKeys = useMemo(
    () => new Set(columns.filter((c) => c.required).map((c) => c.key)),
    [columns]
  );

  const isVisible = useCallback(
    (key: string) => {
      if (!hydrated) return true; // pre-hydration: render everything
      if (requiredKeys.has(key)) return true;
      return !hidden.has(key);
    },
    [hidden, hydrated, requiredKeys]
  );

  const toggle = useCallback(
    (key: string) => {
      if (requiredKeys.has(key)) return;
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        saveHidden(tableKey, next);
        return next;
      });
    },
    [tableKey, requiredKeys]
  );

  const resetToDefault = useCallback(() => {
    const next = new Set<string>();
    for (const c of columns) {
      if (c.defaultVisible === false && !c.required) {
        next.add(c.key);
      }
    }
    setHidden(next);
    saveHidden(tableKey, next);
  }, [columns, tableKey]);

  const hiddenCount = useMemo(() => {
    let n = 0;
    for (const c of columns) {
      if (!c.required && hidden.has(c.key)) n++;
    }
    return n;
  }, [columns, hidden]);

  return { isVisible, toggle, resetToDefault, columns, hiddenCount };
}
