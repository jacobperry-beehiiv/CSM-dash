import { kvGet, kvSet } from "../storage/kv";

/**
 * Idempotency guard for Slack interactivity entry points.
 *
 * Slack's interactivity payloads (view_submission, block_actions) can
 * arrive twice for what the user perceives as one click:
 *
 *   - User double-submits because the modal sits open while the
 *     handler does long work (Drive folder creation + template seed
 *     + HubSpot calls regularly exceed 3 seconds for @bot assign).
 *   - Slack retries when the response misses the 3-second ACK budget.
 *     The `X-Slack-Retry-Num` header catches those at the webhook
 *     edge, but only for events — interactivity retries can ride a
 *     different replay path that doesn't surface as a retry header.
 *
 * Either case fires the same heavy handler twice and posts two
 * near-identical replies to the originating thread. Dedup at the
 * entry point by `view.id` — a fresh id is minted per modal opening,
 * so same id = same intent = drop the second one.
 *
 * KV-backed for cross-isolate visibility. TTL is short (10 min) so
 * the keys can't accumulate in Postgres forever, and long enough that
 * the slowest assign run can't outpace it.
 *
 * The read-then-write is not a true atomic CAS, but the race window
 * is milliseconds and the cost of a missed dedup is just "we run
 * twice again" — same as today. If the race becomes load-bearing
 * we can swap in a Postgres ON CONFLICT upsert.
 */

const KEY_PREFIX = "slack-dedup:";
const TTL_MS = 10 * 60 * 1000;

interface DedupRecord {
  first_seen_at: string;
  /** Free-form context for debugging — callback_id, user, etc. */
  meta?: Record<string, unknown>;
}

export interface AcquireResult {
  acquired: boolean;
  first_seen_at?: string;
  /** Age of the existing record in ms, if any — useful for log
   *  context ("dedup hit at 2.4s into the original"). */
  age_ms?: number;
}

/**
 * Try to claim the lock for `key`. Returns `{acquired: true}` for
 * the first caller; `{acquired: false}` for any caller arriving
 * within `TTL_MS` of the first.
 */
export async function acquireDedupLock(
  key: string,
  meta?: Record<string, unknown>
): Promise<AcquireResult> {
  const fullKey = KEY_PREFIX + key;
  const existing = await kvGet<DedupRecord>(fullKey);
  if (existing?.first_seen_at) {
    const ts = Date.parse(existing.first_seen_at);
    if (Number.isFinite(ts) && Date.now() - ts < TTL_MS) {
      return {
        acquired: false,
        first_seen_at: existing.first_seen_at,
        age_ms: Date.now() - ts,
      };
    }
  }
  await kvSet<DedupRecord>(fullKey, {
    first_seen_at: new Date().toISOString(),
    meta,
  });
  return { acquired: true };
}
