"use client";

import { useState } from "react";

/**
 * Homepage hero heading.
 *
 * For CSM team viewers: the detective-themed dog image visually
 * replaces "Port" in "Portfolio", so the heading reads as
 * "[🕵️ dog]-folio Overview" — a little visual flair scoped to
 * the team that owns the workflow.
 *
 * For non-CSM viewers (admins on a demo screen-share, sales,
 * etc.): renders the standard "Portfolio overview" label so the
 * dashboard reads neutrally outside the team.
 *
 * If the dog asset is missing from /public the image hides itself
 * (matching the broken-image-hide pattern from CsmDogIcon), and
 * we swap the visible label back to "Portfolio overview" so the
 * fallback doesn't read as " -folio Overview" with a phantom gap.
 * Defensive but small.
 */
export function PortfolioHeading({ isCsmTeam }: { isCsmTeam: boolean }) {
  const [dogFailed, setDogFailed] = useState(false);

  if (!isCsmTeam || dogFailed) {
    return (
      <h1 className="text-[40px] leading-[1.1] font-semibold text-fg tracking-tight">
        Portfolio overview
      </h1>
    );
  }
  return (
    <h1 className="text-[40px] leading-[1.1] font-semibold text-fg tracking-tight flex items-center gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/csm-team-dog.png"
        alt="Detective dog"
        className="h-14 w-auto -mr-1 inline-block align-middle"
        onError={() => setDogFailed(true)}
      />
      <span className="leading-none">-folio Overview</span>
    </h1>
  );
}
