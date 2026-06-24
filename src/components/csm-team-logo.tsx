"use client";

import type { CsmDog } from "@/lib/branding/csm-dogs";

/**
 * CSM-team-only header logo. Replaces the beehiiv mark with one
 * of the registered dog icons in `csm-dogs.ts` — the server picks
 * a random one per request and passes it down, so a full page
 * reload cycles through them.
 *
 * Falls back to invisibility (the surrounding `<Link>` keeps its
 * other contents) if the image asset is missing — that mirrors
 * `CsmDogIcon`'s onError handling and keeps a fresh deploy from
 * rendering a broken-image glyph in the header before the asset
 * is uploaded.
 */
export function CsmTeamLogo({ dog }: { dog: CsmDog }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dog.src}
      alt={dog.alt}
      title={dog.alt}
      className="h-7 w-7 object-contain rounded"
      onError={(e) => {
        (e.target as HTMLImageElement).style.visibility = "hidden";
      }}
    />
  );
}
