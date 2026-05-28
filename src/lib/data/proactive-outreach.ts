import { kvGet, kvSet } from "../storage/kv";

/**
 * Lifecycle state for the AM Proactive Outreach pillar (Phase 2b).
 *
 * For every Enterprise account that's crossed the ≥85% sub-cap
 * threshold we track:
 *
 *   ping_sent_at      — when the initial Slack alert posted
 *   ping_message_ts   — Slack ts of the alert (so nudges can thread
 *                       under it instead of cluttering the channel)
 *   last_outreach_at  — when the AM marked outreach as logged for
 *                       this account (manual button on the row).
 *                       Null until the AM acts.
 *   last_nudge_at     — when we last sent a "5 days, still no
 *                       outreach" nudge for this account.
 *
 * Sweep dedupes off ping_sent_at. Nudge dedupes off last_nudge_at +
 * the gap between now and ping_sent_at vs the nudge threshold.
 *
 * Keyed by workspace_id (UUID). Customers without a workspace_id
 * can't be tracked, but that should never happen on Enterprise rows.
 */

export interface ProactiveOutreachEntry {
  ping_sent_at: string;
  ping_message_ts?: string | null;
  last_outreach_at?: string | null;
  last_outreach_by?: string | null;
  last_nudge_at?: string | null;
  /** Free-text note set when an AM marks outreach as logged. */
  note?: string | null;
}

export type ProactiveOutreachMap = Record<string, ProactiveOutreachEntry>;

const KEY = "csm:proactive-outreach:v1";

export async function loadProactiveOutreach(): Promise<ProactiveOutreachMap> {
  return (await kvGet<ProactiveOutreachMap>(KEY)) ?? {};
}

export async function savePingSent(
  workspaceId: string,
  meta: { messageTs?: string | null } = {}
): Promise<ProactiveOutreachMap> {
  const map = { ...(await loadProactiveOutreach()) };
  const existing = map[workspaceId] ?? { ping_sent_at: "" };
  map[workspaceId] = {
    ...existing,
    ping_sent_at: existing.ping_sent_at || new Date().toISOString(),
    ping_message_ts: meta.messageTs ?? existing.ping_message_ts ?? null,
  };
  await kvSet(KEY, map);
  return map;
}

export async function saveNudgeSent(
  workspaceId: string
): Promise<ProactiveOutreachMap> {
  const map = { ...(await loadProactiveOutreach()) };
  const existing = map[workspaceId];
  if (!existing) return map; // can't nudge without a prior ping
  map[workspaceId] = {
    ...existing,
    last_nudge_at: new Date().toISOString(),
  };
  await kvSet(KEY, map);
  return map;
}

export async function saveOutreachLogged(
  workspaceId: string,
  meta: { loggedBy?: string | null; note?: string | null } = {}
): Promise<ProactiveOutreachMap> {
  const map = { ...(await loadProactiveOutreach()) };
  const existing = map[workspaceId];
  if (!existing) {
    // No prior ping recorded — still mark it so the row shows
    // outreach-logged. This handles the case where AM acts before
    // the sweep has run (or the threshold-crossing fires).
    map[workspaceId] = {
      ping_sent_at: "",
      last_outreach_at: new Date().toISOString(),
      last_outreach_by: meta.loggedBy ?? null,
      note: meta.note ?? null,
    };
  } else {
    map[workspaceId] = {
      ...existing,
      last_outreach_at: new Date().toISOString(),
      last_outreach_by: meta.loggedBy ?? null,
      note: meta.note ?? existing.note ?? null,
    };
  }
  await kvSet(KEY, map);
  return map;
}

export async function bulkSaveOutreachLogged(
  workspaceIds: string[],
  meta: { loggedBy?: string | null; note?: string | null } = {}
): Promise<ProactiveOutreachMap> {
  if (workspaceIds.length === 0) return loadProactiveOutreach();
  const map = { ...(await loadProactiveOutreach()) };
  const stamp = new Date().toISOString();
  for (const id of workspaceIds) {
    if (!id) continue;
    const existing = map[id];
    if (existing) {
      map[id] = {
        ...existing,
        last_outreach_at: stamp,
        last_outreach_by: meta.loggedBy ?? null,
        note: meta.note ?? existing.note ?? null,
      };
    } else {
      map[id] = {
        ping_sent_at: "",
        last_outreach_at: stamp,
        last_outreach_by: meta.loggedBy ?? null,
        note: meta.note ?? null,
      };
    }
  }
  await kvSet(KEY, map);
  return map;
}

export async function clearProactiveEntry(
  workspaceId: string
): Promise<ProactiveOutreachMap> {
  const map = { ...(await loadProactiveOutreach()) };
  delete map[workspaceId];
  await kvSet(KEY, map);
  return map;
}
