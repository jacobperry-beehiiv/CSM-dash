import { kvGet, kvSet } from "../storage/kv";

/**
 * Dedupe set for the Live-board quarter check-in engine (see
 * src/lib/engines/live-quarter-checkins.ts). Ensures a given
 * (workspace_id, quarter) pair fires exactly once per renewal cycle —
 * even if the daily sweep runs on consecutive days that both compute
 * the same days-until-renewal value, or a manual re-trigger lands.
 *
 * Storage shape mirrors renewal-milestones-fired.ts exactly:
 *   • Single KV row keyed `csm:live-quarter-checkins-fired:v1`.
 *   • Value: { rows: Record<key, FiredRecord> } where `key` is
 *     `${workspace_id}::${quarter}::${renewal_iso}`. The renewal-date
 *     suffix lets the same workspace re-fire the same quarter on the
 *     NEXT annual cycle without extra bookkeeping.
 *
 * Prune strategy: rows whose renewal-date suffix is more than one
 * year in the past are dropped on write — same horizon as the
 * renewal-milestones store, for the same reason (anything older is
 * guaranteed superseded by a fresher fire for the same pair).
 */

const KEY = "csm:live-quarter-checkins-fired:v1";
const PRUNE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export type LiveQuarter = "Q1" | "Q2" | "Q3";

export interface LiveQuarterCheckinFiredRecord {
  workspace_id: string;
  quarter: LiveQuarter;
  /** The ISO date (YYYY-MM-DD, UTC) of the renewal cycle this
   *  check-in was fired against. Combined with (workspace_id,
   *  quarter) forms the composite key. */
  renewal_iso: string;
  fired_at: string;
}

interface FiredBlob {
  rows: Record<string, LiveQuarterCheckinFiredRecord>;
}

const EMPTY_BLOB: FiredBlob = { rows: {} };

function firedKey(
  workspaceId: string,
  quarter: LiveQuarter,
  renewalIso: string
): string {
  return `${workspaceId}::${quarter}::${renewalIso}`;
}

async function loadBlob(): Promise<FiredBlob> {
  return (await kvGet<FiredBlob>(KEY)) ?? EMPTY_BLOB;
}

export async function hasLiveQuarterCheckinFired(
  workspaceId: string,
  quarter: LiveQuarter,
  renewalIso: string
): Promise<boolean> {
  const blob = await loadBlob();
  return blob.rows[firedKey(workspaceId, quarter, renewalIso)] != null;
}

export async function markLiveQuarterCheckinFired(
  record: LiveQuarterCheckinFiredRecord
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
  rows[firedKey(record.workspace_id, record.quarter, record.renewal_iso)] = record;
  blob.rows = rows;
  await kvSet(KEY, blob);
}
