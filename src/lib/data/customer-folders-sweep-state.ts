import { kvGet, kvSet } from "../storage/kv";
import type { FolderMatchCandidate } from "./folder-match";

/**
 * KV-backed state for the Drive customer-folders sweep + review flow.
 *
 * Two things live here:
 *   1. The review queue populated by /api/csm/customer-folders/scan.
 *   2. Post-apply metadata so a subsequent scan can filter out
 *      folders we've already resolved.
 *
 * One row keyed `csm:customer-folders-sweep:v1`. Not per-CSM — the
 * sweep is a team-wide backfill exercise; whichever admin scans is
 * doing it on behalf of everyone.
 */

const KEY = "csm:customer-folders-sweep:v1";

/** How the CSM resolved this queue row on the last review pass. */
export type FolderSelection =
  /** No decision yet — the CSM hasn't reviewed. */
  | { kind: "pending" }
  /** Approved a specific candidate; apply endpoint will write this
   *  folder URL to the customer_folder property. */
  | { kind: "approved"; workspace_id: string }
  /** Admin explicitly skipped this folder (unrelated / spam / test).
   *  Sticky across scans so we don't re-surface the same row. */
  | { kind: "skipped" };

export interface FolderQueueRow {
  folder_id: string;
  folder_name: string;
  folder_url: string;
  candidates: FolderMatchCandidate[];
  selection: FolderSelection;
  /** ISO of when scan first saw this folder. */
  first_seen_at: string;
  /** ISO of when apply-endpoint successfully wrote to HubSpot.
   *  Present only after a successful apply. */
  applied_at?: string;
  applied_workspace_id?: string;
}

export interface CustomerFoldersSweepState {
  queue: Record<string, FolderQueueRow>;
  last_scan_at?: string;
  /** Snapshot of the last-scan summary for the UI: quick numbers
   *  without re-computing over the queue. */
  last_scan_summary?: {
    ran_at: string;
    folders_scanned: number;
    folders_new: number;
    folders_auto_matched: number;
    folders_needs_review: number;
    folders_no_candidate: number;
    folders_skipped_already_set: number;
    truncated: boolean;
  };
  fetched_at: string;
}

function emptyState(): CustomerFoldersSweepState {
  return {
    queue: {},
    fetched_at: new Date(0).toISOString(),
  };
}

export async function loadSweepState(): Promise<CustomerFoldersSweepState> {
  const blob = await kvGet<CustomerFoldersSweepState>(KEY);
  return blob ?? emptyState();
}

export async function saveSweepState(
  state: CustomerFoldersSweepState
): Promise<void> {
  await kvSet<CustomerFoldersSweepState>(KEY, {
    ...state,
    fetched_at: new Date().toISOString(),
  });
}

/** Set the selection for one queue row. Idempotent. Preserves
 *  applied_at so a re-approve after apply doesn't clear history. */
export function setSelection(
  state: CustomerFoldersSweepState,
  folderId: string,
  selection: FolderSelection
): void {
  const row = state.queue[folderId];
  if (!row) return;
  state.queue[folderId] = { ...row, selection };
}

/** Mark a queue row as successfully applied. Rows in this state
 *  drop out of the "needs attention" filter in the UI. */
export function markApplied(
  state: CustomerFoldersSweepState,
  folderId: string,
  workspace_id: string
): void {
  const row = state.queue[folderId];
  if (!row) return;
  state.queue[folderId] = {
    ...row,
    applied_at: new Date().toISOString(),
    applied_workspace_id: workspace_id,
  };
}
