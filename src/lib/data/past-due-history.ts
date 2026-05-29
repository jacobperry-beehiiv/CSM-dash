import { kvGet, kvSet } from "../storage/kv";
import { loadPastDue, type PastDueRow } from "../engines/am-cohorts";
import type {
  PastDueEpisode,
  PastDueHistoryEntry,
  PastDueHistoryMap,
} from "./past-due-history-types";

/**
 * Historical episode log for past-due customers.
 *
 * The dashboard only sees the *current* snapshot of q24620 — but
 * "this customer keeps falling into past-due" is a multi-month
 * pattern. We reconcile against q24620 once a day (or on demand)
 * and record per-episode start/end + failure counters.
 *
 * Pure types + monthsObserved() live in ./past-due-history-types.ts
 * so client components can import them without dragging in the
 * Postgres/Metabase deps the reconciler needs.
 *
 * Tracking is forward-only — we begin recording the day this ships.
 * Earlier history isn't captured. (Backfill from the encrypted
 * snapshot commit log is possible later; out of scope for now.)
 */

// Re-export types so existing consumers that imported them from this
// file keep working without an updated path.
export type {
  PastDueEpisode,
  PastDueHistoryEntry,
  PastDueHistoryMap,
} from "./past-due-history-types";
export { monthsObserved } from "./past-due-history-types";

const KEY = "csm:past-due-history:v1";
const META_KEY = "csm:past-due-history-meta:v1";

interface ReconcileMeta {
  last_reconciled_at: string | null;
}

export async function loadPastDueHistory(): Promise<PastDueHistoryMap> {
  return (await kvGet<PastDueHistoryMap>(KEY)) ?? {};
}

export async function loadReconcileMeta(): Promise<ReconcileMeta> {
  return (
    (await kvGet<ReconcileMeta>(META_KEY)) ?? { last_reconciled_at: null }
  );
}

interface ReconcileResult {
  episodes_opened: number;
  episodes_closed: number;
  episodes_updated: number;
  customers_tracked: number;
}

/** Reconcile the historical state against the current q24620 snapshot.
 *  Idempotent — running twice in a row does nothing on the second
 *  pass because the in-progress episodes are already up to date. */
export async function reconcilePastDueHistory(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    episodes_opened: 0,
    episodes_closed: 0,
    episodes_updated: 0,
    customers_tracked: 0,
  };
  const [currentRows, state] = await Promise.all([
    loadPastDue(),
    loadPastDueHistory(),
  ]);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const now = new Date().toISOString();
  const next: PastDueHistoryMap = { ...state };
  const currentlyPastDue = new Set<string>();

  // Pass 1: open/update episodes for everyone currently past-due.
  for (const r of currentRows) {
    if (!r.customer_id) continue;
    currentlyPastDue.add(r.customer_id);
    const existing = next[r.customer_id];
    if (!existing) {
      next[r.customer_id] = {
        customer_id: r.customer_id,
        email: r.email,
        workspace_name: null,
        customer_success_manager: r.customer_success_manager,
        episodes: [openEpisode(r, today)],
        last_observed_at: now,
      };
      result.episodes_opened++;
      continue;
    }
    const lastEp = existing.episodes[existing.episodes.length - 1];
    if (lastEp && lastEp.episode_ended_at === null) {
      // Active episode — update running counters.
      lastEp.failure_count = bumpFailureCount(lastEp, r);
      lastEp.max_arr_dollars = Math.max(
        lastEp.max_arr_dollars,
        r.arr_dollars ?? 0
      );
      lastEp.plan = r.price_name ?? lastEp.plan;
      result.episodes_updated++;
    } else {
      // Closed (or no) prior episode — open a new one.
      existing.episodes.push(openEpisode(r, today));
      result.episodes_opened++;
    }
    existing.email = r.email ?? existing.email;
    existing.customer_success_manager =
      r.customer_success_manager ?? existing.customer_success_manager;
    existing.last_observed_at = now;
  }

  // Pass 2: close any active episodes for customers NOT in today's
  // snapshot — they've paid (or churned out of q24620 some other way).
  for (const [id, entry] of Object.entries(next)) {
    if (currentlyPastDue.has(id)) continue;
    const lastEp = entry.episodes[entry.episodes.length - 1];
    if (lastEp && lastEp.episode_ended_at === null) {
      lastEp.episode_ended_at = today;
      result.episodes_closed++;
    }
  }

  result.customers_tracked = Object.keys(next).length;
  await kvSet(KEY, next);
  await kvSet<ReconcileMeta>(META_KEY, { last_reconciled_at: now });
  return result;
}

function openEpisode(r: PastDueRow, today: string): PastDueEpisode {
  return {
    episode_started_at: today,
    episode_ended_at: null,
    failure_count: r.failure_code ? 1 : 0,
    max_arr_dollars: r.arr_dollars ?? 0,
    plan: r.price_name ?? null,
  };
}

function bumpFailureCount(ep: PastDueEpisode, r: PastDueRow): number {
  // Each daily reconcile counts +1 if the row has a fresh failure_code
  // recorded since the last sync. We don't have a perfect "is this a
  // new attempt vs. the same one we saw yesterday" signal, so this is
  // best-effort — caps at +1 per reconcile to avoid runaway counts.
  return ep.failure_count + (r.failure_code ? 1 : 0);
}
