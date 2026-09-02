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
 * Data source: Metabase's Postgres replica (DB.POSTGRES=2). The
 * `zendesk_tickets` table is keyed on publication_id, so we roll up
 * to workspace via a join on `publications.organization_id`. A
 * workspace with multiple publications aggregates across all of them.
 *
 * ─── Priority mapping ──────────────────────────────────────────────
 * Zendesk itself has {low, normal, high, urgent}. In production
 * beehiiv's rows we've only ever seen normal/high/urgent, so the
 * summary buckets are `high_priority_30d` (high + urgent) and a
 * separate `urgent_30d` count for the "call the fire brigade" tier.
 * A future `low` bucket would sink into `total_30d - high_priority_30d`.
 */

const KEY = "csm:zendesk-tickets:v1";
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
 * Sweep counters + recent tickets for a set of workspace ids. One
 * Postgres round-trip regardless of the batch size (Postgres handles
 * a `WHERE ... = ANY(ARRAY[...])` against a few thousand UUIDs
 * comfortably) plus one lighter round-trip for the recent-ticket
 * sample. Merges into whatever's already in the overlay so a partial
 * sweep (e.g. one CSM's book) doesn't wipe the rest.
 */
export async function refreshZendeskOverlay(
  workspaceIds: string[],
  opts?: { lookbackDays?: number }
): Promise<ZendeskBlob> {
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  // Guard against SQL injection — runNativeQuery interpolates values
  // into the query string; a stray non-UUID sneaks a malformed AST
  // through and breaks parsing at best. Silently drop bad ids so a
  // caller with mixed data doesn't fail the whole sweep.
  const clean = Array.from(
    new Set(workspaceIds.filter((id) => typeof id === "string" && UUID_RE.test(id)))
  );
  if (clean.length === 0) {
    return loadZendeskOverlay();
  }
  const arrLit = "ARRAY[" + clean.map((id) => `'${id}'::uuid`).join(",") + "]";
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

  // Recent-tickets sample — one query pulls newest N per workspace
  // via a window function; we then bucket in-memory. Postgres's
  // partitioned ROW_NUMBER handles the ranking without ambiguity even
  // when two tickets land on the same second.
  const recentSql = `
    SELECT
      p.organization_id::text AS workspace_id,
      zt.zendesk_id,
      zt.subject,
      zt.priority,
      zt.status,
      zt.created_at::text
    FROM (
      SELECT
        zt.*,
        ROW_NUMBER() OVER (
          PARTITION BY p.organization_id
          ORDER BY zt.created_at DESC
        ) AS rn
      FROM zendesk_tickets zt
      JOIN publications p ON p.id = zt.publication_id
      WHERE p.organization_id = ANY(${arrLit})
        AND zt.created_at > NOW() - INTERVAL '${lookbackDays} days'
    ) zt
    JOIN publications p ON p.id = zt.publication_id
    WHERE zt.rn <= ${RECENT_SAMPLE_LIMIT}
    ORDER BY zt.created_at DESC
  `;
  const recentRows = (await runNativeQuery(DB.POSTGRES, recentSql)) as Array<{
    workspace_id: string;
    zendesk_id: number;
    subject: string | null;
    priority: string | null;
    status: string | null;
    created_at: string;
  }>;
  const recentByWs = new Map<string, ZendeskRecentTicket[]>();
  for (const r of recentRows) {
    const list = recentByWs.get(r.workspace_id) ?? [];
    list.push({
      zendesk_id: r.zendesk_id,
      subject: r.subject,
      priority: r.priority,
      status: r.status,
      created_at: r.created_at,
    });
    recentByWs.set(r.workspace_id, list);
  }

  const now = new Date().toISOString();
  const prior = await loadZendeskOverlay();
  // Overlay merge — start from what's already stored so a partial
  // refresh (one CSM's book, or a manual "refresh this workspace"
  // trigger) doesn't blow away rows outside the current batch. Rows
  // in `clean` get their new values; a workspace with ZERO tickets
  // in the window is stamped with total_30d=0 so the chip renders
  // "no tickets" (a positive "clean" signal, not a stale value).
  const rows: Record<string, ZendeskSummary> = { ...prior.rows };
  const seen = new Set(counterRows.map((r) => r.workspace_id));
  for (const r of counterRows) {
    rows[r.workspace_id] = {
      workspace_id: r.workspace_id,
      total_30d: r.total_30d,
      high_priority_30d: r.high_priority_30d,
      urgent_30d: r.urgent_30d,
      latest_created_at: r.latest_created_at,
      recent: recentByWs.get(r.workspace_id) ?? [],
      fetched_at: now,
    };
  }
  // Workspaces we scanned but that had no tickets — stamp a zero row
  // so the chip reads "0 tickets in 30d" instead of falling back to
  // whatever we last knew (which might have been a spike that's now
  // resolved).
  for (const id of clean) {
    if (seen.has(id)) continue;
    rows[id] = {
      workspace_id: id,
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
