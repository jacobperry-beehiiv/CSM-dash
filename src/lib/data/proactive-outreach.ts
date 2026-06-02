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
  /**
   * Explicit user-facing status — drives the AM panel's Status column
   * and the badge displayed alongside the company name. Independent
   * of the timestamps above so the AM can override the auto-set
   * value ("Pinged" / "Outreach made") with a custom step like
   * "Awaiting response" or "Renewed".
   *
   * Empty / undefined → fall back to deriving from timestamps the way
   * we did before this field existed.
   *
   * The allowed list lives in settings.am.proactive_outreach_statuses
   * — admins can add/remove via /settings/slack.
   */
  status?: string | null;
  status_updated_at?: string | null;
  status_updated_by?: string | null;
}

export type ProactiveOutreachMap = Record<string, ProactiveOutreachEntry>;

const KEY = "csm:proactive-outreach:v1";

export async function loadProactiveOutreach(): Promise<ProactiveOutreachMap> {
  return (await kvGet<ProactiveOutreachMap>(KEY)) ?? {};
}

export async function savePingSent(
  workspaceId: string,
  meta: {
    messageTs?: string | null;
    /** Status string to stamp alongside the ping. Defaults to
     *  "Pinged" so the engine and any future direct caller don't
     *  have to repeat the label. */
    status?: string | null;
  } = {}
): Promise<ProactiveOutreachMap> {
  const map = { ...(await loadProactiveOutreach()) };
  const existing = map[workspaceId] ?? { ping_sent_at: "" };
  const stamp = new Date().toISOString();
  map[workspaceId] = {
    ...existing,
    ping_sent_at: existing.ping_sent_at || stamp,
    ping_message_ts: meta.messageTs ?? existing.ping_message_ts ?? null,
    status: meta.status === undefined ? "Pinged" : meta.status,
    status_updated_at: stamp,
    status_updated_by: existing.status_updated_by ?? null,
  };
  await kvSet(KEY, map);
  return map;
}

/** Set the explicit user-facing status for a workspace. Pass `null`
 *  or `""` to clear back to "derive from timestamps" mode. Tracks
 *  the viewer + timestamp for audit. */
export async function setProactiveStatus(
  workspaceId: string,
  status: string | null,
  meta: { updatedBy?: string | null } = {}
): Promise<ProactiveOutreachMap> {
  const map = { ...(await loadProactiveOutreach()) };
  const existing = map[workspaceId] ?? { ping_sent_at: "" };
  const stamp = new Date().toISOString();
  const cleaned = status?.trim() || null;
  map[workspaceId] = {
    ...existing,
    status: cleaned,
    status_updated_at: stamp,
    status_updated_by: meta.updatedBy ?? null,
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
  meta: {
    loggedBy?: string | null;
    note?: string | null;
    /** Status to stamp alongside last_outreach_at. Defaults to
     *  "Outreach made". Pass null to leave the status alone (e.g.
     *  callers that want to keep "Pinged" visible). */
    status?: string | null;
  } = {}
): Promise<ProactiveOutreachMap> {
  if (workspaceIds.length === 0) return loadProactiveOutreach();
  const map = { ...(await loadProactiveOutreach()) };
  const stamp = new Date().toISOString();
  const statusValue =
    meta.status === undefined ? "Outreach made" : meta.status;
  for (const id of workspaceIds) {
    if (!id) continue;
    const existing = map[id];
    if (existing) {
      map[id] = {
        ...existing,
        last_outreach_at: stamp,
        last_outreach_by: meta.loggedBy ?? null,
        note: meta.note ?? existing.note ?? null,
        status: statusValue === null ? existing.status : statusValue,
        status_updated_at: statusValue === null ? existing.status_updated_at : stamp,
        status_updated_by:
          statusValue === null
            ? existing.status_updated_by
            : meta.loggedBy ?? null,
      };
    } else {
      map[id] = {
        ping_sent_at: "",
        last_outreach_at: stamp,
        last_outreach_by: meta.loggedBy ?? null,
        note: meta.note ?? null,
        status: statusValue,
        status_updated_at: statusValue ? stamp : null,
        status_updated_by: meta.loggedBy ?? null,
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
