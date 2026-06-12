import { kvGet, kvSet } from "../storage/kv";

/**
 * Dedupe state for deliverability critical Slack pings — one emission
 * per post_id. Cleared posts stay in the map (harmless); a new send from
 * the same publication is a different post_id and can notify fresh.
 */

export interface DeliverabilitySlackNotifiedEntry {
  notified_at: string;
}

export type DeliverabilitySlackNotifiedMap = Record<
  string,
  DeliverabilitySlackNotifiedEntry
>;

const KEY = "csm:deliverability-slack-notified:v1";

export async function loadDeliverabilitySlackNotified(): Promise<DeliverabilitySlackNotifiedMap> {
  return (await kvGet<DeliverabilitySlackNotifiedMap>(KEY)) ?? {};
}

export async function markDeliverabilitySlackNotified(
  postIds: string[]
): Promise<void> {
  if (postIds.length === 0) return;
  const map = { ...(await loadDeliverabilitySlackNotified()) };
  const now = new Date().toISOString();
  for (const id of postIds) {
    map[id] = { notified_at: now };
  }
  await kvSet(KEY, map);
}
