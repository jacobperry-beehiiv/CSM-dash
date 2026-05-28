import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-account outreach status for the AM Past Due tab. Used by the
 * Follow-Up sub-tab to track who's been touched + where each customer
 * sits in the outreach lifecycle. Shared across all viewers so a CSM
 * who handles a row sees the same "Touched" badge as the AM team
 * that filed the first draft.
 *
 *   untouched      — no outreach yet (default; not stored)
 *   touched        — first-touch draft has been created
 *   follow_up_sent — follow-up draft has been created
 *   paid           — customer paid; row will fall out of q24620 next
 *                    sync but state is kept around for the audit log
 *   lost           — customer churned / written off
 *
 * The store is intentionally tiny (Record<customerId, …>) — past-due
 * rows are typically <300 at any time and the lifecycle states are
 * one short string each. Reads always hit the KV fresh so concurrent
 * AM + CSM edits don't stomp each other.
 */

export type PastDueOutreachStatus =
  | "touched"
  | "follow_up_sent"
  | "paid"
  | "lost";

export interface PastDueOutreachEntry {
  status: PastDueOutreachStatus;
  updated_at: string;
  updated_by?: string | null;
  note?: string | null;
}

export type PastDueOutreachMap = Record<string, PastDueOutreachEntry>;

const KEY = "csm:past-due-outreach:v1";

export async function loadPastDueOutreach(): Promise<PastDueOutreachMap> {
  return (await kvGet<PastDueOutreachMap>(KEY)) ?? {};
}

export async function setPastDueOutreach(
  customerId: string,
  status: PastDueOutreachStatus | null,
  meta: { updatedBy?: string | null; note?: string | null } = {}
): Promise<PastDueOutreachMap> {
  const map = { ...(await loadPastDueOutreach()) };
  if (status === null) {
    delete map[customerId];
  } else {
    map[customerId] = {
      status,
      updated_at: new Date().toISOString(),
      updated_by: meta.updatedBy ?? null,
      note: meta.note ?? null,
    };
  }
  await kvSet(KEY, map);
  return map;
}

/** Bulk-set helper for the "mark N customers as touched" action that
 *  fires after a bulk-draft creation. Single KV write so concurrent
 *  bulk-marks serialize at the Postgres layer. */
export async function bulkSetPastDueOutreach(
  customerIds: string[],
  status: PastDueOutreachStatus,
  meta: { updatedBy?: string | null; note?: string | null } = {}
): Promise<PastDueOutreachMap> {
  if (customerIds.length === 0) return loadPastDueOutreach();
  const map = { ...(await loadPastDueOutreach()) };
  const stamp = new Date().toISOString();
  for (const id of customerIds) {
    if (!id) continue;
    map[id] = {
      status,
      updated_at: stamp,
      updated_by: meta.updatedBy ?? null,
      note: meta.note ?? null,
    };
  }
  await kvSet(KEY, map);
  return map;
}
