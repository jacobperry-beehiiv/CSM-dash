/**
 * Pure types + helpers for the past-due episode history. Split from
 * past-due-history.ts so client components can import these without
 * dragging in the Postgres/KV/Metabase dependencies the reconciler
 * needs (which fail at bundle time when shipped to the browser).
 */

export interface PastDueEpisode {
  episode_started_at: string;
  episode_ended_at: string | null;
  failure_count: number;
  max_arr_dollars: number;
  plan: string | null;
}

export interface PastDueHistoryEntry {
  customer_id: string;
  email: string | null;
  workspace_name: string | null;
  customer_success_manager: string | null;
  episodes: PastDueEpisode[];
  /** ISO timestamp — last sync we saw this customer in q24620. */
  last_observed_at: string;
}

export type PastDueHistoryMap = Record<string, PastDueHistoryEntry>;

/** Count distinct YYYY-MM buckets across all episode date ranges for
 *  a single customer. An episode that spans Jan-Feb 2026 counts both
 *  months. An active episode counts every month from its start through
 *  today. */
export function monthsObserved(entry: PastDueHistoryEntry): number {
  const seen = new Set<string>();
  for (const ep of entry.episodes) {
    const start = new Date(`${ep.episode_started_at}T00:00:00Z`);
    const end = ep.episode_ended_at
      ? new Date(`${ep.episode_ended_at}T00:00:00Z`)
      : new Date();
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)
    );
    const stop = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)
    );
    while (cursor.getTime() <= stop.getTime()) {
      seen.add(
        `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(
          2,
          "0"
        )}`
      );
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return seen.size;
}
