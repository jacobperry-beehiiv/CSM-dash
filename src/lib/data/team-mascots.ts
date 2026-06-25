import { kvGet, kvSet } from "../storage/kv";

/**
 * Team-mascot registry — uploaded animal photos that cycle through
 * the CSM-team-only visual chrome (header logo + to-do celebration).
 *
 * Images live in Vercel Blob (public access, CDN-cached). This
 * module only stores the metadata in KV: the blob URL, an
 * optional label ("Sherlock — Jacob's dog"), and audit fields.
 * Images get fetched directly from the Vercel Blob CDN — never
 * proxied through us.
 *
 * Pure JSON, no I/O beyond KV. Safe to import from any server-side
 * surface.
 */

export interface TeamMascot {
  id: string;
  /** Public CDN URL from Vercel Blob. */
  url: string;
  /** Optional caption — used as the <img alt> + a hover tooltip,
   *  e.g. "Sherlock — Jacob's dog" or "Pebbles, Mac's cat". */
  label: string;
  /** Blob pathname (the `pathname` field returned by put()). Stored
   *  so deletes can call del() with the same identifier the blob
   *  was created under. */
  blob_pathname: string;
  /** Bytes — used for the settings UI's "X / 100 MB used" line. */
  size_bytes: number;
  /** Viewer who uploaded it. Audit-only for now; could later gate
   *  delete to original uploader + admin. */
  added_by: string | null;
  added_at: string;
}

const KEY = "csm:team-mascots:v1";

export async function loadTeamMascots(): Promise<TeamMascot[]> {
  return (await kvGet<TeamMascot[]>(KEY)) ?? [];
}

export async function saveTeamMascots(list: TeamMascot[]): Promise<void> {
  await kvSet(KEY, list);
}

export async function addTeamMascot(mascot: TeamMascot): Promise<TeamMascot[]> {
  const list = [...(await loadTeamMascots()), mascot];
  await saveTeamMascots(list);
  return list;
}

export async function removeTeamMascot(
  id: string
): Promise<{ removed: TeamMascot | null; list: TeamMascot[] }> {
  const before = await loadTeamMascots();
  const removed = before.find((m) => m.id === id) ?? null;
  const list = before.filter((m) => m.id !== id);
  if (removed) await saveTeamMascots(list);
  return { removed, list };
}
