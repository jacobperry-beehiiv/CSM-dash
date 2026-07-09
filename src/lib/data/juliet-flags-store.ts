import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-workspace "needs Juliet outreach" escalation flag. Any CSM can
 * raise it from the at-risk tab when they think Juliet should own the
 * next touch on an account; the /csm "Flagged for Juliet" tab reads
 * this map to render her queue.
 *
 * Deliberately un-scoped by CSM — this is a shared team queue, not a
 * per-viewer list. The optional note is the CSM's short "why" so
 * Juliet can prioritize without a DM round-trip.
 *
 * Storage shape:
 *   • Single KV row keyed `csm:juliet-flags:v1`.
 *   • Value: Record<workspace_id, JulietFlag>. Absent key = not flagged.
 *
 * Design mirrors [[flag-resolutions]]: raise = write entry, clear =
 * delete entry. No history — if a CSM raises, clears, and re-raises
 * on the same workspace, only the latest raise is retained. Signals
 * / customer notes streams cover the audit trail if we ever need it.
 */

const KEY = "csm:juliet-flags:v1";

export interface JulietFlag {
  flagged_at: string;
  flagged_by?: string | null;
  /** Short "why Juliet should touch this" note. Freeform. Optional. */
  note?: string | null;
}

export type JulietFlagMap = Record<string, JulietFlag>;

// No module-level cache — same rationale as flag-resolutions.ts. Warm-
// pool isolates would otherwise serve stale reads after a POST.
export async function loadJulietFlags(): Promise<JulietFlagMap> {
  return (await kvGet<JulietFlagMap>(KEY)) ?? {};
}

export async function setJulietFlag(
  workspaceId: string,
  flagged: boolean,
  meta: { flaggedBy?: string | null; note?: string | null } = {}
): Promise<JulietFlagMap> {
  const map = { ...(await loadJulietFlags()) };
  if (flagged) {
    map[workspaceId] = {
      flagged_at: new Date().toISOString(),
      flagged_by: meta.flaggedBy ?? null,
      note: meta.note?.trim() || null,
    };
  } else {
    delete map[workspaceId];
  }
  await kvSet(KEY, map);
  return map;
}

export async function isJulietFlagged(
  workspaceId: string | null | undefined
): Promise<boolean> {
  if (!workspaceId) return false;
  const map = await loadJulietFlags();
  return map[workspaceId] != null;
}
