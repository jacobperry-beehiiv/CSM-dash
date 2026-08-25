import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-workspace Slack pricing-thread anchor for the CSM-owned renewals
 * workflow. Every renewal opens exactly one kickoff message in the
 * configured `settings.am.renewals_slack_channel_id`, and the milestone
 * engine + "Renewal Confirmed" lifecycle hook both thread-reply into
 * that saved `thread_ts` so Richard / Juliet / Priya see pacing in one
 * place.
 *
 * Storage shape:
 *   • Single KV row keyed `csm:renewal-threads:v1`.
 *   • Value: Record<workspace_id, RenewalThreadRecord>. Absent = no
 *     thread exists yet for that workspace (first 90d milestone will
 *     auto-open one, or `@normbot renewal` if the CSM kicks it off
 *     manually earlier).
 *
 * There is no history: if we ever need to "close and re-open" a
 * pricing thread for a customer (edge case — the renewal date rolls
 * over to next year), we overwrite the row. The prior thread stays
 * live in Slack but is no longer the ping target. Cleared threads
 * are surfaced via `appendActionLog` when we build the "Renewal
 * Confirmed" hook — that entry captures the closure timestamp.
 *
 * Two open flavors matter to callers:
 *   • `origin: "manual"` — a CSM ran `@normbot renewal <company>`
 *     and picked this customer from the candidate list.
 *   • `origin: "milestone_engine"` — the 90-day sweep auto-opened
 *     the thread because no CSM had done it manually yet.
 *
 * The two flavors carry the same rendering weight (both are "the"
 * pricing thread for the workspace) but the `origin` is retained
 * so the action-log entry can say who opened what.
 */

const KEY = "csm:renewal-threads:v1";

export type RenewalThreadOrigin = "manual" | "milestone_engine";

export interface RenewalThreadRecord {
  channel_id: string;
  thread_ts: string;
  opened_by: string;
  opened_at: string;
  origin: RenewalThreadOrigin;
  /**
   * Short snapshot of the state we posted the kickoff message
   * against. Purely for debugging / audit — the engine reads the
   * live customer row when it needs pacing details for the reply
   * pings, not this blob.
   */
  kickoff_context?: {
    workspace_id: string;
    workspace_name?: string;
    lifecycle_stage?: string | null;
    renewal_date?: string | null;
    arr?: number | null;
  } | null;
}

export type RenewalThreadMap = Record<string, RenewalThreadRecord>;

export async function loadRenewalThreads(): Promise<RenewalThreadMap> {
  return (await kvGet<RenewalThreadMap>(KEY)) ?? {};
}

export async function getRenewalThread(
  workspaceId: string | null | undefined
): Promise<RenewalThreadRecord | null> {
  if (!workspaceId) return null;
  const map = await loadRenewalThreads();
  return map[workspaceId] ?? null;
}

export async function saveRenewalThread(
  workspaceId: string,
  record: RenewalThreadRecord
): Promise<RenewalThreadRecord> {
  const map = { ...(await loadRenewalThreads()) };
  map[workspaceId] = record;
  await kvSet(KEY, map);
  return record;
}

/**
 * Idempotent thread creation. If a thread already exists for the
 * workspace, returns the existing record and does NOT touch KV.
 * Otherwise writes the supplied record and returns it. Callers who
 * need to distinguish "already existed" from "newly saved" can
 * compare identity or check whether `opened_at` equals the value
 * they passed in.
 */
export async function saveRenewalThreadIfAbsent(
  workspaceId: string,
  record: RenewalThreadRecord
): Promise<{ record: RenewalThreadRecord; created: boolean }> {
  const map = { ...(await loadRenewalThreads()) };
  const existing = map[workspaceId];
  if (existing) return { record: existing, created: false };
  map[workspaceId] = record;
  await kvSet(KEY, map);
  return { record, created: true };
}

/**
 * Remove a workspace's thread pointer entirely. Intended for admin
 * ops only (a botched thread the team wants to re-open elsewhere).
 * Not used by the milestone engine or the lifecycle hook — those
 * paths never delete a thread even after "Renewal Confirmed" fires,
 * because the confirmation reply itself lands INSIDE the thread.
 */
export async function clearRenewalThread(
  workspaceId: string
): Promise<void> {
  const map = { ...(await loadRenewalThreads()) };
  if (!(workspaceId in map)) return;
  delete map[workspaceId];
  await kvSet(KEY, map);
}
