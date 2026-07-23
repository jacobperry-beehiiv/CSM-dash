import { kvGet, kvSet } from "../storage/kv";

/**
 * Dedupe set for the CSM-owned renewals milestone engine. Ensures a
 * given (workspace_id, milestone_days) pair fires exactly once across
 * the customer's renewal cycle — even if the daily sweep runs on
 * consecutive days that both round to the same "days-until" value, or
 * if a manual re-trigger lands.
 *
 * Storage shape:
 *   • Single KV row keyed `csm:renewal-milestones-fired:v1`.
 *   • Value: { rows: Record<key, FiredRecord> } where `key` is
 *     `${workspace_id}::${milestone_days}::${renewal_iso}`. The
 *     renewal-date suffix lets the same workspace re-fire milestones
 *     on the NEXT renewal cycle (e.g. an annual customer who renews
 *     on 2026-09-01 gets a fresh 90d fire for 2027-09-01 next year)
 *     without extra bookkeeping.
 *
 * Prune strategy: rows whose renewal-date suffix is more than one
 * year in the past are dropped on write. Anything older than that
 * is guaranteed to have been superseded by a fresher fire for the
 * same (workspace, milestone) pair, and keeping it around would
 * bloat the blob unnecessarily.
 */

const KEY = "csm:renewal-milestones-fired:v1";
const PRUNE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export interface RenewalMilestoneFiredRecord {
  workspace_id: string;
  milestone_days: number;
  /**
   * The ISO date (YYYY-MM-DD, UTC) of the renewal this milestone was
   * fired against. Combined with (workspace_id, milestone_days) forms
   * the composite key.
   */
  renewal_iso: string;
  fired_at: string;
  /** Slack thread ts of the reply (or the kickoff post at 90d). Kept
   *  for tracing / debugging; not currently rendered anywhere. */
  slack_ts?: string | null;
}

interface FiredBlob {
  rows: Record<string, RenewalMilestoneFiredRecord>;
}

const EMPTY_BLOB: FiredBlob = { rows: {} };

function firedKey(
  workspaceId: string,
  milestoneDays: number,
  renewalIso: string
): string {
  return `${workspaceId}::${milestoneDays}::${renewalIso}`;
}

async function loadBlob(): Promise<FiredBlob> {
  return (await kvGet<FiredBlob>(KEY)) ?? EMPTY_BLOB;
}

export async function hasMilestoneFired(
  workspaceId: string,
  milestoneDays: number,
  renewalIso: string
): Promise<boolean> {
  const blob = await loadBlob();
  return blob.rows[firedKey(workspaceId, milestoneDays, renewalIso)] != null;
}

export async function markMilestoneFired(
  record: RenewalMilestoneFiredRecord
): Promise<void> {
  const blob = { ...(await loadBlob()) };
  const rows = { ...blob.rows };
  const cutoff = Date.now() - PRUNE_HORIZON_MS;
  for (const [k, v] of Object.entries(rows)) {
    const t = Date.parse(v.renewal_iso);
    if (Number.isFinite(t) && t < cutoff) {
      delete rows[k];
    }
  }
  rows[firedKey(record.workspace_id, record.milestone_days, record.renewal_iso)] =
    record;
  blob.rows = rows;
  await kvSet(KEY, blob);
}

/** Diagnostic — returns every fired row for a workspace across all
 *  milestones and past renewal cycles. Currently unused; useful when
 *  we build a "renewals status" surface later. */
export async function listFiredForWorkspace(
  workspaceId: string
): Promise<RenewalMilestoneFiredRecord[]> {
  const blob = await loadBlob();
  return Object.values(blob.rows).filter((r) => r.workspace_id === workspaceId);
}
