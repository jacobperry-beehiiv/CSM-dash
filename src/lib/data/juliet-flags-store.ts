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

/** Workflow status for a Juliet-flagged workspace. Rows in KV before
 *  the status field existed default to "open" — the field is optional
 *  on the type for back-compat, but the panel always treats a missing
 *  value as "open". */
export type JulietFlagStatus =
  | "open"
  /** Juliet has done the outreach; the row stays visible in her
   *  queue (dimmed) so she can still refer back to context. */
  | "outreach_made"
  /** Fully resolved — the conversation ran its course. Same
   *  visual treatment as outreach_made today but distinct semantics
   *  so we can split the queue later if she wants. */
  | "resolved";

export interface JulietFlag {
  flagged_at: string;
  flagged_by?: string | null;
  /** Short "why Juliet should touch this" note. Freeform. Optional. */
  note?: string | null;
  /** Current workflow status. Missing = "open" (back-compat with
   *  rows created before this field existed). */
  status?: JulietFlagStatus;
  /** ISO of the last status change. Set together with `status`;
   *  cleared when the flag is re-raised. */
  status_updated_at?: string | null;
  /** Session email of whoever moved the status (usually Juliet
   *  herself, occasionally the flag-raiser going back to correct). */
  status_updated_by?: string | null;
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
    // Re-raising resets status to "open" implicitly — clearing the
    // status field entirely (rather than writing "open") keeps the
    // blob small since missing = "open" by convention.
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

/** Update the workflow status on an existing flag. No-op if the
 *  workspace isn't currently flagged — status only makes sense in
 *  the context of an open raise. Preserves the raise metadata
 *  (flagged_at, flagged_by, note) so the audit trail stays intact. */
export async function setJulietFlagStatus(
  workspaceId: string,
  status: JulietFlagStatus,
  actedBy: string | null = null
): Promise<JulietFlagMap> {
  const map = { ...(await loadJulietFlags()) };
  const existing = map[workspaceId];
  if (!existing) return map;
  map[workspaceId] = {
    ...existing,
    status,
    status_updated_at: new Date().toISOString(),
    status_updated_by: actedBy,
  };
  await kvSet(KEY, map);
  return map;
}
