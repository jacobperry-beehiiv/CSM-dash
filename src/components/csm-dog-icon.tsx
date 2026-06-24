/**
 * CSM-team-only dog icon used in the to-do celebration sweep.
 *
 * The image itself lives at `public/csm-team-dog.png` so it's
 * served as a static asset; just an `<img>` ref keeps the
 * component simple and avoids the Next/Image runtime overhead for
 * a 32-48px decoration. The `next/image` optimization isn't worth
 * it at this size.
 *
 * Falls back to a transparent box if the asset is missing — the
 * celebration sweep still plays, just without the dog. That keeps
 * the dashboard from rendering a broken-image icon on a fresh
 * deploy where the asset hasn't been uploaded yet.
 */
export function CsmDogIcon({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/csm-team-dog.png"
      alt=""
      aria-hidden="true"
      className={className}
      // Hide the broken-image glyph if the asset is missing.
      onError={(e) => {
        (e.target as HTMLImageElement).style.visibility = "hidden";
      }}
    />
  );
}
