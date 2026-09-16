import { DB, runNativeQuery } from "../metabase";
import { kvGet, kvSet } from "../storage/kv";

/**
 * Zendesk-tickets overlay — per-workspace 30-day support-ticket
 * counters + a short list of the most-recent tickets, refreshed on a
 * 6-hour cron sweep. Powers the compact chip on the Approaching
 * Enterprise + Enterprise Only panels ("🎫 12 · 3 high · 1 urgent").
 *
 * Storage shape mirrors [[send-cadence]] / [[hubspot-overlay]]:
 *   • Single KV row keyed `csm:zendesk-tickets:v1`.
 *   • Value: `{ rows: Record<workspace_id, ZendeskSummary>, fetched_at }`.
 *
 * ─── Match key: workspace_id via publication → organization ────────
 * Every ticket in the `zendesk_tickets` table carries a
 * `publication_id`; every publication belongs to exactly one
 * organization (which IS the beehiiv workspace). Join
 *   zendesk_tickets → publications ON id = publication_id
 * and group by `publications.organization_id`. That surfaces every
 * ticket filed against any publication in the workspace regardless
 * of which user filed it — the earlier `owner_email` path silently
 * missed tickets from non-primary team members (validated on
 * Jacob's book: 9 real Ashton/Overstory/etc. tickets that never
 * showed up).
 *
 * `publications.id` is the indexed PK, so the join is O(log n) per
 * ticket; adding a workspace to the sweep is free.
 *
 * Data source: Metabase's Postgres replica (DB.POSTGRES=2).
 *
 * ─── Priority mapping ──────────────────────────────────────────────
 * Zendesk itself has {low, normal, high, urgent}. In production
 * beehiiv's rows we've only ever seen normal/high/urgent, so the
 * summary buckets are `high_priority_30d` (high + urgent) and a
 * separate `urgent_30d` count for the "call the fire brigade" tier.
 * A future `low` bucket would sink into `total_30d - high_priority_30d`.
 */

const KEY = "csm:zendesk-tickets:v1";
/** Workspace IDs are UUIDs. Filter the input list against this
 *  before interpolating into the SQL — the values come from the
 *  trusted customer book, but interpolation is cheap to harden and
 *  it also drops empty strings / accidental non-UUIDs before they
 *  reach Postgres. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Days back the sweep counts against. 30 matches the CSM cadence
 *  for other surfaces (proactive outreach, feature utilization) so
 *  the chip reads consistently with adjacent columns. */
export const DEFAULT_LOOKBACK_DAYS = 30;

/** Cap the per-row recent-tickets sample so the KV blob stays small
 *  even for a heavy enterprise like Ashton with 40 tickets/mo. The
 *  chip preview shows the newest few; the "open in Zendesk" link
 *  covers the rest. */
export const RECENT_SAMPLE_LIMIT = 8;

export interface ZendeskRecentTicket {
  zendesk_id: number;
  subject: string | null;
  priority: string | null;
  status: string | null;
  created_at: string;
}

export interface ZendeskSummary {
  workspace_id: string;
  total_30d: number;
  high_priority_30d: number;
  urgent_30d: number;
  /** Most-recent ticket timestamp — powers a "last ticket 3 days ago"
   *  affordance on the chip tooltip so a CSM can eyeball recency. */
  latest_created_at: string | null;
  /** Newest N tickets in the window. Capped at RECENT_SAMPLE_LIMIT to
   *  keep the KV blob under Vercel's edge-config practical size.
   *  Enough to satisfy a spot check without opening Zendesk. */
  recent: ZendeskRecentTicket[];
  fetched_at: string;
}

export interface ZendeskBlob {
  rows: Record<string, ZendeskSummary>;
  fetched_at: string;
  /** Days back the sweep ran with. Preserved on the blob so a change
   *  to DEFAULT_LOOKBACK_DAYS doesn't render mis-labeled chips until
   *  the next sweep. */
  lookback_days: number;
}

const EMPTY_BLOB: ZendeskBlob = {
  rows: {},
  fetched_at: new Date(0).toISOString(),
  lookback_days: DEFAULT_LOOKBACK_DAYS,
};

export async function loadZendeskOverlay(): Promise<ZendeskBlob> {
  const blob = await kvGet<ZendeskBlob>(KEY);
  if (!blob) return EMPTY_BLOB;
  return blob;
}

export async function saveZendeskOverlay(blob: ZendeskBlob): Promise<void> {
  await kvSet<ZendeskBlob>(KEY, blob);
}

/**
 * Sweep counters + recent tickets for a set of workspace IDs.
 * Matches on `publications.organization_id` — the join from
 * `zendesk_tickets.publication_id → publications.id` gives us the
 * workspace directly, so any ticket filed against any publication
 * in the workspace surfaces regardless of the ticket-filer's user
 * record. Non-UUID entries in the input array are dropped
 * silently.
 *
 * Two Postgres round-trips: counters + a recent-tickets sample via
 * a partitioned ROW_NUMBER window. Merges into whatever's already
 * in the overlay so a partial sweep doesn't wipe the rest;
 * workspaces we scanned that had no tickets in the window get
 * zero-stamped so the chip reads "no tickets" (a positive "clean"
 * signal) instead of holding onto a stale count.
 */
export async function refreshZendeskOverlay(
  workspaceIds: string[],
  opts?: { lookbackDays?: number }
): Promise<ZendeskBlob> {
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const cleanIds = [
    ...new Set(
      workspaceIds
        .map((id) => (typeof id === "string" ? id.trim().toLowerCase() : ""))
        .filter((id) => UUID_RE.test(id))
    ),
  ];
  if (cleanIds.length === 0) {
    return loadZendeskOverlay();
  }
  const arrLit =
    "ARRAY[" + cleanIds.map((id) => `'${id}'`).join(",") + "]::uuid[]";

  const counterSql = `
    SELECT
      p.organization_id::text AS workspace_id,
      COUNT(*)::int AS total_30d,
      COUNT(*) FILTER (WHERE zt.priority IN ('high','urgent'))::int AS high_priority_30d,
      COUNT(*) FILTER (WHERE zt.priority = 'urgent')::int AS urgent_30d,
      MAX(zt.created_at)::text AS latest_created_at
    FROM zendesk_tickets zt
    JOIN publications p ON p.id = zt.publication_id
    WHERE p.organization_id = ANY(${arrLit})
      AND zt.created_at > NOW() - INTERVAL '${lookbackDays} days'
    GROUP BY 1
  `;
  const counterRows = (await runNativeQuery(DB.POSTGRES, counterSql)) as Array<{
    workspace_id: string;
    total_30d: number;
    high_priority_30d: number;
    urgent_30d: number;
    latest_created_at: string | null;
  }>;

  const recentSql = `
    SELECT
      inner_q.workspace_id,
      inner_q.zendesk_id,
      inner_q.subject,
      inner_q.priority,
      inner_q.status,
      inner_q.created_at::text
    FROM (
      SELECT
        zt.zendesk_id,
        zt.subject,
        zt.priority,
        zt.status,
        zt.created_at,
        p.organization_id::text AS workspace_id,
        ROW_NUMBER() OVER (
          PARTITION BY p.organization_id
          ORDER BY zt.created_at DESC
        ) AS rn
      FROM zendesk_tickets zt
      JOIN publications p ON p.id = zt.publication_id
      WHERE p.organization_id = ANY(${arrLit})
        AND zt.created_at > NOW() - INTERVAL '${lookbackDays} days'
    ) inner_q
    WHERE inner_q.rn <= ${RECENT_SAMPLE_LIMIT}
    ORDER BY inner_q.created_at DESC
  `;
  const recentRows = (await runNativeQuery(DB.POSTGRES, recentSql)) as Array<{
    workspace_id: string;
    zendesk_id: number;
    subject: string | null;
    priority: string | null;
    status: string | null;
    created_at: string;
  }>;
  const recentByWorkspace = new Map<string, ZendeskRecentTicket[]>();
  for (const r of recentRows) {
    const wsId = r.workspace_id.toLowerCase();
    const list = recentByWorkspace.get(wsId) ?? [];
    list.push({
      zendesk_id: r.zendesk_id,
      subject: r.subject,
      priority: r.priority,
      status: r.status,
      created_at: r.created_at,
    });
    recentByWorkspace.set(wsId, list);
  }

  const now = new Date().toISOString();
  const prior = await loadZendeskOverlay();
  // Overlay merge — start from what's already stored so a partial
  // refresh (one CSM's book, or a manual "refresh this workspace"
  // trigger) doesn't blow away rows outside the current batch. Rows
  // that matched get their new values; rows we scanned but that had
  // no tickets in the window get zero-stamped so the chip reads
  // "no tickets" (a positive "clean" signal), not a stale value
  // from a previous spike.
  const rows: Record<string, ZendeskSummary> = { ...prior.rows };
  const hitWorkspaces = new Set<string>();
  for (const r of counterRows) {
    const wsId = r.workspace_id.toLowerCase();
    hitWorkspaces.add(wsId);
    rows[wsId] = {
      workspace_id: wsId,
      total_30d: r.total_30d,
      high_priority_30d: r.high_priority_30d,
      urgent_30d: r.urgent_30d,
      latest_created_at: r.latest_created_at,
      recent: recentByWorkspace.get(wsId) ?? [],
      fetched_at: now,
    };
  }
  for (const wsId of cleanIds) {
    if (hitWorkspaces.has(wsId)) continue;
    rows[wsId] = {
      workspace_id: wsId,
      total_30d: 0,
      high_priority_30d: 0,
      urgent_30d: 0,
      latest_created_at: null,
      recent: [],
      fetched_at: now,
    };
  }
  const blob: ZendeskBlob = {
    rows,
    fetched_at: now,
    lookback_days: lookbackDays,
  };
  await saveZendeskOverlay(blob);
  return blob;
}
