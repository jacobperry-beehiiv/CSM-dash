"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  fontFamilyFor,
  type Personalization,
} from "@/lib/data/personalization-types";

/**
 * Personalization runtime — applies the viewer's saved theme overrides
 * to the rendered DOM and exposes the Business Mode toggle.
 *
 * Inputs:
 *   - `initial`: the viewer's saved Personalization, OR null when
 *     they're ineligible / have nothing saved. Resolved server-side
 *     in the root layout so there's no flash of un-personalized
 *     paint.
 *
 * Outputs:
 *   - CSS variable overrides on the document root: `--accent` (+
 *     derived `--accent-hover`), `--font-sans`.
 *   - Context exposing the active Personalization (or null when
 *     Business Mode is on or the user is ineligible) so other
 *     client components (header name + logo override, settings page)
 *     can read it without re-fetching.
 *   - `useBusinessMode()` hook — boolean + setter, backed by
 *     localStorage so the toggle survives navigation but NOT clearing
 *     local data. Reset per device.
 *
 * Business Mode (when on):
 *   - Strips the CSS-variable overrides — defaults apply.
 *   - `usePersonalization()` returns `null` so name/logo overrides
 *     don't render either.
 */

const STORAGE_KEY = "csm-dashboard-business-mode";

interface ContextValue {
  /** The active personalization, or null when Business Mode is on
   *  OR the viewer never saved anything OR they're ineligible. */
  active: Personalization | null;
  businessMode: boolean;
  setBusinessMode: (next: boolean) => void;
  /** True after the first effect tick — gates components that need
   *  to read localStorage (Business Mode default) from rendering
   *  before hydration completes. Without this, the server-rendered
   *  HTML and the first client render disagree on whether to apply
   *  personalization, which leaks a "default → custom" flicker. */
  hydrated: boolean;
}

const PersonalizationContext = createContext<ContextValue>({
  active: null,
  businessMode: false,
  setBusinessMode: () => {},
  hydrated: false,
});

export function PersonalizationProvider({
  initial,
  children,
}: {
  initial: Personalization | null;
  children: React.ReactNode;
}) {
  const [businessMode, setBusinessModeState] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Read Business Mode from localStorage on mount. Wrapped in try/catch
  // because storage access can throw in private browsing / restricted
  // iframes.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "1") setBusinessModeState(true);
    } catch {
      /* no-op */
    }
    setHydrated(true);
  }, []);

  const setBusinessMode = (next: boolean) => {
    setBusinessModeState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* no-op */
    }
  };

  // Apply CSS variable overrides to documentElement so the entire
  // tree picks them up (Tailwind's `bg-accent`, etc. are wired to
  // these vars). Removed when Business Mode is on so the defaults
  // apply.
  useEffect(() => {
    if (!hydrated) return;
    const root = document.documentElement;
    const applyOverrides = !businessMode && initial !== null;

    if (applyOverrides && initial?.accent_color) {
      root.style.setProperty("--accent", initial.accent_color);
      // No reliable way to derive a hover shade purely in CSS — the
      // default `--accent-hover` is a hand-picked deeper lavender.
      // Reuse the same color for hover when overridden; users rarely
      // notice the missing hover delta vs the bigger win of "the
      // accent is mine."
      root.style.setProperty("--accent-hover", initial.accent_color);
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-hover");
    }

    if (applyOverrides && initial?.font_key) {
      root.style.setProperty("--font-sans", fontFamilyFor(initial.font_key));
    } else {
      root.style.removeProperty("--font-sans");
    }
  }, [hydrated, businessMode, initial]);

  const value = useMemo<ContextValue>(() => {
    return {
      active: businessMode ? null : initial,
      businessMode,
      setBusinessMode,
      hydrated,
    };
  }, [businessMode, initial, hydrated]);

  return (
    <PersonalizationContext.Provider value={value}>
      {children}
    </PersonalizationContext.Provider>
  );
}

export function usePersonalization(): Personalization | null {
  return useContext(PersonalizationContext).active;
}

export function useBusinessMode(): {
  on: boolean;
  setOn: (next: boolean) => void;
  hydrated: boolean;
} {
  const { businessMode, setBusinessMode, hydrated } =
    useContext(PersonalizationContext);
  return { on: businessMode, setOn: setBusinessMode, hydrated };
}

/** Small inline pill — toggles Business Mode. Hidden until the
 *  provider hydrates so it doesn't render an "Off" state on the
 *  server when a user actually has it "On" in localStorage. */
export function BusinessModeToggle() {
  const { on, setOn, hydrated } = useBusinessMode();
  if (!hydrated) return null;
  return (
    <button
      type="button"
      onClick={() => setOn(!on)}
      className={`text-xs px-2 py-1 rounded-md border transition ${
        on
          ? "border-border-strong bg-canvas text-fg hover:bg-surface-2"
          : "border-border bg-surface-2 text-muted hover:bg-canvas"
      }`}
      title={
        on
          ? "Business Mode is ON — your custom theme is hidden. Click to restore."
          : "Click to hide your custom theme — useful for screen shares."
      }
    >
      {on ? "Business Mode: On" : "Business Mode"}
    </button>
  );
}
