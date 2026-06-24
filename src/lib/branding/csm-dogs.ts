/**
 * Registry of CSM-team header dog icons.
 *
 * Each entry is the public-asset path of an image that should
 * appear in place of the beehiiv mark in the header for viewers
 * who are part of the CSM team. The layout picks one at random
 * per request, so a full page reload cycles through them.
 *
 * To add a new dog: drop the image into `public/` (matching the
 * existing csm-team-dog.png pattern — these aren't tracked in git
 * because they're uploaded out-of-band per deploy target) and
 * append its path here.
 *
 * `alt` doubles as a hover tooltip via `title=` on the rendered
 * <img>. It's also the screen-reader label so keep it short.
 */
export interface CsmDog {
  src: string;
  alt: string;
}

export const CSM_DOGS: CsmDog[] = [
  { src: "/csm-team-dog.png", alt: "Detective dog" },
  { src: "/csm-team-dog-bee.png", alt: "Bee dog" },
];

/** Returns a random entry. Called once per request from the
 *  server-side layout — no client-side randomness means no
 *  hydration mismatch. */
export function pickRandomCsmDog(): CsmDog {
  const idx = Math.floor(Math.random() * CSM_DOGS.length);
  return CSM_DOGS[idx] ?? CSM_DOGS[0];
}
