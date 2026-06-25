"use client";

import { useState } from "react";
import type { CsmDog } from "@/lib/branding/csm-dogs";

/**
 * Homepage hero heading.
 *
 * For CSM team viewers: a mascot image visually replaces "Port" in
 * "Portfolio", so the heading reads as "[mascot]-folio Overview" —
 * a little visual flair scoped to the team that owns the workflow.
 *
 * The mascot is server-picked once per request (see /app/page.tsx)
 * so the heading aligns with the header logo on the same load —
 * both surfaces use the SAME randomly-chosen mascot for any given
 * page render, which feels more intentional than two independent
 * picks.
 *
 * For non-CSM viewers (admins on a demo screen-share, sales,
 * etc.): renders the standard "Portfolio overview" label.
 *
 * If the mascot image fails to load (404 / blob deleted) we swap
 * the visible label back to "Portfolio overview" so the fallback
 * doesn't read as a phantom-gap " -folio Overview".
 */
export function PortfolioHeading({ mascot }: { mascot: CsmDog | null }) {
  const [imgFailed, setImgFailed] = useState(false);

  if (!mascot || imgFailed) {
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
        src={mascot.src}
        alt={mascot.alt}
        className="h-14 w-auto -mr-1 inline-block align-middle"
        onError={() => setImgFailed(true)}
      />
      <span className="leading-none">-folio Overview</span>
    </h1>
  );
}
