"use client";

import { createContext, useContext } from "react";
import type { CsmDog } from "@/lib/branding/csm-dogs";

/**
 * Active mascot list, resolved server-side once per request and
 * passed to client components via this provider.
 *
 * Two consumers:
 *   • The header logo (server-rendered with a single picked dog).
 *   • The to-do celebration overlay (client-side; it re-rolls a
 *     random pick each time the celebration mounts so completing
 *     several to-dos in a row surfaces different team pets).
 */

const MascotsContext = createContext<CsmDog[]>([]);

export function MascotsProvider({
  value,
  children,
}: {
  value: CsmDog[];
  children: React.ReactNode;
}) {
  return (
    <MascotsContext.Provider value={value}>{children}</MascotsContext.Provider>
  );
}

export function useMascots(): CsmDog[] {
  return useContext(MascotsContext);
}

/** Pick a random mascot from the active list. Returns null if the
 *  provider was wired up with an empty list (e.g. a non-CSM viewer
 *  whose celebration shouldn't render a mascot anyway). */
export function useRandomMascot(): CsmDog | null {
  const list = useMascots();
  if (list.length === 0) return null;
  // Client-side Math.random is fine here — the celebration mounts
  // post-hydration on a click, so there's no SSR to mismatch with.
  const idx = Math.floor(Math.random() * list.length);
  return list[idx] ?? null;
}
