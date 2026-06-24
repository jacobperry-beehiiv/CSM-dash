"use client";

import { createContext, useContext } from "react";

/**
 * Tiny client context that carries "is the current viewer a CSM
 * team member?" — server-resolved in the root layout via
 * isCsmTeamMember() and passed in as the `value`. Read by client
 * components that need to swap chrome for CSMs (e.g. the Sherlock
 * dog icon in the to-do celebration sweep).
 *
 * Standalone from PersonalizationProvider on purpose — that one
 * carries a richer payload AND is gated by Gmail-connected status.
 * "CSM team" is a looser membership check with different scope, so
 * keeping the contexts separate keeps the surface cleaner.
 */

const Context = createContext<boolean>(false);

export function CsmTeamProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useIsCsmTeam(): boolean {
  return useContext(Context);
}
