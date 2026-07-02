import { kvGet, kvSet } from "../storage/kv";
import {
  EMPTY_WINS_BLOB,
  type CandidateWin,
  type WinStatus,
  type WinsBlob,
} from "./wins-types";

/**
 * KV store for the Wins & Opportunities Phase 1 surface. Single row
 * at `csm:wins:v1` — all candidates packed together so the /csm?tab=wins
 * render is one read. Same shape as sybill-ingest-state / customer-
 * folders-sweep-state.
 *
 * No module-level cache — Vercel warm-isolate pool would let one
 * isolate serve a stale candidate list to a CSM who just dismissed a
 * row on another isolate. (Same reasoning as flag-resolutions.ts.)
 */

const KEY = "csm:wins:v1";

export async function loadWinsBlob(): Promise<WinsBlob> {
  const blob = await kvGet<WinsBlob>(KEY);
  if (!blob) return { ...EMPTY_WINS_BLOB, fetched_at: new Date().toISOString() };
  return { ...blob, fetched_at: new Date().toISOString() };
}

export async function saveWinsBlob(blob: WinsBlob): Promise<void> {
  await kvSet(KEY, blob);
}

/** Upsert one candidate. Preserves prior `status` when the incoming
 *  win_id already exists in a non-`candidate` state — the detection
 *  engine keeps re-firing every day, but a CSM's Dismiss / Sent
 *  decision should stick even when the rule technically still holds. */
export async function upsertCandidate(win: CandidateWin): Promise<void> {
  const blob = await loadWinsBlob();
  const prior = blob.candidates[win.win_id];
  const next: CandidateWin = prior
    ? {
        ...win,
        status:
          prior.status === "dismissed" ||
          prior.status === "sent" ||
          prior.status === "approved"
            ? prior.status
            : win.status,
      }
    : win;
  blob.candidates[win.win_id] = next;
  await saveWinsBlob(blob);
}

/** Batched upsert — one KV write for the whole run. The daily
 *  detection endpoint uses this so a book of ~500 candidates doesn't
 *  fan out to ~500 writes. Preserves prior terminal statuses per
 *  upsertCandidate's rule. */
export async function upsertCandidates(
  wins: CandidateWin[]
): Promise<{ inserted: number; updated: number }> {
  if (wins.length === 0) return { inserted: 0, updated: 0 };
  const blob = await loadWinsBlob();
  let inserted = 0;
  let updated = 0;
  for (const win of wins) {
    const prior = blob.candidates[win.win_id];
    if (prior) {
      updated++;
      blob.candidates[win.win_id] = {
        ...win,
        status:
          prior.status === "dismissed" ||
          prior.status === "sent" ||
          prior.status === "approved"
            ? prior.status
            : win.status,
      };
    } else {
      inserted++;
      blob.candidates[win.win_id] = win;
    }
  }
  blob.last_detection_at = new Date().toISOString();
  await saveWinsBlob(blob);
  return { inserted, updated };
}

export async function setStatus(
  winId: string,
  status: WinStatus
): Promise<CandidateWin | null> {
  const blob = await loadWinsBlob();
  const win = blob.candidates[winId];
  if (!win) return null;
  const next = { ...win, status };
  blob.candidates[winId] = next;
  await saveWinsBlob(blob);
  return next;
}

/** Drop candidates whose detected_at is older than `days` days.
 *  Called at the end of every detection run so the KV row doesn't
 *  balloon with historical wins that never got acted on. */
export async function pruneOlderThan(days: number): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const blob = await loadWinsBlob();
  const kept: Record<string, CandidateWin> = {};
  let pruned = 0;
  for (const [id, win] of Object.entries(blob.candidates)) {
    const ts = Date.parse(win.detected_at);
    if (isNaN(ts) || ts >= cutoff) {
      kept[id] = win;
    } else {
      pruned++;
    }
  }
  if (pruned === 0) return 0;
  blob.candidates = kept;
  await saveWinsBlob(blob);
  return pruned;
}

/** True when the account has a `sent` win within the last N days.
 *  The cadence guard from the plan — even without Phase 2's monthly
 *  curation, we don't re-fire a new candidate for an account that
 *  just had a win sent this month. */
export function accountRecentlySent(
  blob: WinsBlob,
  accountId: string,
  withinDays: number,
  now: Date = new Date()
): boolean {
  const cutoff = now.getTime() - withinDays * 24 * 60 * 60 * 1000;
  for (const win of Object.values(blob.candidates)) {
    if (win.account_id !== accountId) continue;
    if (win.status !== "sent") continue;
    const ts = Date.parse(win.detected_at);
    if (!isNaN(ts) && ts >= cutoff) return true;
  }
  return false;
}
