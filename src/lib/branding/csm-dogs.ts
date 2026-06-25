import { loadTeamMascots } from "../data/team-mascots";

/**
 * Registry of CSM-team mascot icons that cycle through the
 * header logo + the to-do celebration overlay.
 *
 * Two sources of mascots:
 *
 *   1. **Bundled defaults** — the two PNGs every CSM-on-Vercel
 *      deployment is expected to have under /public. Used as the
 *      starter set when nobody's uploaded a custom mascot yet.
 *
 *   2. **Uploaded via /settings/team-mascots** — public Vercel
 *      Blob URLs stored in KV. Any CSM team member can upload
 *      their own pet; the new mascot enters the rotation
 *      immediately for everyone.
 *
 * Mode rule: once the team has uploaded at least one mascot, the
 * uploaded set takes over entirely. The defaults come back only if
 * the uploaded set is empty. This avoids the awkward "I deleted my
 * mascot and Sherlock came back" surprise — the team chooses.
 */
export interface CsmDog {
  src: string;
  alt: string;
}

export const DEFAULT_CSM_DOGS: CsmDog[] = [
  { src: "/csm-team-dog.png", alt: "Detective dog" },
  { src: "/csm-team-dog-bee.png", alt: "Bee dog" },
];

/** Server-side: resolve the active mascot list. Reads KV for the
 *  uploaded set; falls back to the bundled defaults when empty. */
export async function loadActiveCsmDogs(): Promise<CsmDog[]> {
  const uploaded = await loadTeamMascots();
  if (uploaded.length === 0) return DEFAULT_CSM_DOGS;
  return uploaded.map((m) => ({ src: m.url, alt: m.label || "Team mascot" }));
}

/** Pick a random entry from the resolved active list. Server-only
 *  so there's no client-side randomness → no hydration mismatch. */
export async function pickRandomCsmDog(): Promise<CsmDog> {
  const list = await loadActiveCsmDogs();
  const idx = Math.floor(Math.random() * list.length);
  return list[idx] ?? list[0] ?? DEFAULT_CSM_DOGS[0];
}
