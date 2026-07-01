import { kvGet, kvSet } from "../storage/kv";

/**
 * Per-CSM state for the Sybill ingest sweep at
 * `src/app/api/csm/sybill/sync/route.ts`.
 *
 * Tracks two things:
 *   1. Which Gmail messages we've already turned into to-dos (dedup
 *      key on rerun).
 *   2. A short audit log of recent sweep outcomes (surfaced on the
 *      /settings/sybill page so a CSM can see "last sync created
 *      3 to-dos from 2 calls" and dig into the activity).
 *
 * Single KV row keyed `csm:sybill-ingest:v1`, packed across all
 * CSMs (small blob, fast reads). No module cache — same posture as
 * flag-resolutions / customer-overrides.
 */

const KEY = "csm:sybill-ingest:v1";
const RECENT_RUNS_CAP = 20;

export interface SybillRunRecord {
  ran_at: string;
  messages_scanned: number;
  messages_skipped_already_processed: number;
  messages_no_action_items: number;
  todos_created: number;
  /** Up to 5 short error strings — full errors live in Vercel logs. */
  errors: string[];
}

export interface SybillCsmState {
  /** Gmail message_id → ISO of when we created todos from it. */
  processed: Record<string, string>;
  last_sync_at?: string;
  recent_runs: SybillRunRecord[];
}

export interface SybillIngestState {
  per_csm: Record<string, SybillCsmState>;
  fetched_at: string;
}

function emptyState(): SybillIngestState {
  return { per_csm: {}, fetched_at: new Date(0).toISOString() };
}

function emptyCsmState(): SybillCsmState {
  return { processed: {}, recent_runs: [] };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function loadIngestState(): Promise<SybillIngestState> {
  const blob = await kvGet<SybillIngestState>(KEY);
  return blob ?? emptyState();
}

export async function saveIngestState(blob: SybillIngestState): Promise<void> {
  await kvSet<SybillIngestState>(KEY, {
    ...blob,
    fetched_at: new Date().toISOString(),
  });
}

/** Pure read of one CSM's slice. Returns an empty state when the
 *  CSM has never run the sweep. Caller mutates in place + saves. */
export function getCsmState(
  blob: SybillIngestState,
  csmEmail: string
): SybillCsmState {
  const key = normalizeEmail(csmEmail);
  if (!blob.per_csm[key]) blob.per_csm[key] = emptyCsmState();
  return blob.per_csm[key];
}

/** Stamp a message as processed. Idempotent — calling twice with
 *  the same id is a no-op. */
export function markMessageProcessed(
  state: SybillCsmState,
  messageId: string,
  at: string = new Date().toISOString()
): void {
  if (!state.processed[messageId]) {
    state.processed[messageId] = at;
  }
}

/** Append a sweep record. Caps the array at RECENT_RUNS_CAP via
 *  FIFO drop so the KV blob stays small even after months of use. */
export function appendRunRecord(
  state: SybillCsmState,
  record: SybillRunRecord
): void {
  state.recent_runs.unshift(record);
  if (state.recent_runs.length > RECENT_RUNS_CAP) {
    state.recent_runs.length = RECENT_RUNS_CAP;
  }
  state.last_sync_at = record.ran_at;
}
