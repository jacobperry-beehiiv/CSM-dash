/**
 * Feature-update items pulled from a Slack channel and persisted to KV.
 * One per message we've seen. Stored sorted DESC by `posted_at_ms` for
 * cheap reads — newest first, no client-side sort.
 *
 * Types are split from the store so client components can import them
 * without dragging in the Postgres KV (which is Node-only).
 */

export interface FeatureUpdate {
  /** Slack message `ts` — globally unique per workspace per channel, so we
   *  use it as the dedupe key. Numeric-string like "1716302445.123456". */
  id: string;
  /** Slack channel ID the message lives in. */
  channel_id: string;
  /** Slack user id of the author (e.g. "U01ABCDEF"). May be null for
   *  app/bot posts. */
  author_user_id: string | null;
  /** Best-effort display name for the author. We fetch this via
   *  `users.info` at sync time and cache it on the record so reads
   *  don't hit Slack again. Falls back to "Unknown" when the lookup
   *  fails (missing `users:read` scope, deleted user, etc.). */
  author_name: string;
  /** Raw mrkdwn text from Slack. Re-rendered to HTML on the client by
   *  `renderSlackMrkdwn` — kept in raw form here so we can iterate the
   *  renderer without re-syncing. */
  text: string;
  /** Unix ms when the message was posted. Derived from `ts`. */
  posted_at_ms: number;
  /** Deep link into Slack so a click jumps to the original message
   *  (with reactions, threaded replies, etc.). */
  permalink: string | null;
}

export interface FeatureUpdatesStore {
  /** Sorted DESC by posted_at_ms. Capped at MAX_STORED_UPDATES on write. */
  updates: FeatureUpdate[];
  /** ISO timestamp of the last successful sync run. Surfaced in the UI
   *  so viewers can tell whether the feed is current. */
  last_synced_at: string | null;
  /** Most recent Slack `ts` we've seen — used as the `oldest=` cursor
   *  on the next sync so we only fetch new messages. */
  cursor_ts: string | null;
}

/** Soft cap so the KV row doesn't grow unbounded. ~6 months of weekly
 *  updates at 5 messages/week ≈ 130 — set well above that. */
export const MAX_STORED_UPDATES = 500;

/** Convert a Slack message `ts` to unix milliseconds. */
export function tsToMs(ts: string): number {
  const n = Number(ts);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n * 1000);
}
