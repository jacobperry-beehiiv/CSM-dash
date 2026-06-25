"use client";

import { useState } from "react";
import { useRandomMascot } from "./mascots-provider";

/**
 * CSM-team-only mascot icon used in the to-do celebration sweep.
 *
 * Picks a random entry from the active mascot list on every mount,
 * so completing several to-dos in a row surfaces different team
 * pets. The list comes from MascotsProvider (server-resolved once
 * per request).
 *
 * Falls back to the bundled detective-dog PNG when the provider
 * surfaces no mascots — keeps a fresh deploy from rendering a
 * broken-image glyph during the celebration.
 *
 * On image error: hide the element (matches the historical
 * behavior of this component). The celebration sweep still plays;
 * the dog just doesn't appear.
 */
export function CsmDogIcon({ className }: { className?: string }) {
  const mascot = useRandomMascot();
  const [failed, setFailed] = useState(false);
  // `mascot` may be null when no mascots are uploaded AND we're
  // a non-CSM viewer (the provider was passed an empty list at the
  // server boundary). Render nothing in that case rather than
  // falling back to the default — non-CSM viewers shouldn't see
  // mascots at all.
  if (!mascot || failed) {
    return null;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={mascot.src}
      alt={mascot.alt}
      aria-hidden="true"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
