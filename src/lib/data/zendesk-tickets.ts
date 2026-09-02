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
 * ─── Match key: owner_email ──────────────────────────────────────
 * We look up tickets by matching the ticket-filer's email to the
 * customer's owner_email (the primary contact stored in the CSM
 * dashboard). Explicit product decision, not the publication_id
 * join we started with — a workspace's owner is the person we want
 * to know is filing tickets, and joining through publications also
 * caught tickets from unrelated team members that skewed the count.
 *
 * The engine still keys the overlay on workspace_id so the panels
 * can look up per row without carrying the email through the
 * customer object graph. Email → workspace mapping happens inside
 * the sweep (callers pass in {workspace_id, owner_email} pairs).
 *
 * Data source: Metabase's Postgres replica (DB.POSTGRES=2). Join
 * `zendesk_tickets` to `users` on user_id → filter on `users.email`
 * (citext, so case-insensitive by default).
 *
 * ─── Priority mapping ──────────────────────────────────────────────
 * Zendesk itself has {low, normal, high, urgent}. In production
 * beehiiv's rows we've only ever seen normal/high/urgent, so the
 * summary buckets are `high_priority_30d` (high + urgent) and a
 * separate `urgent_30d` count for the "call the fire brigade" tier.
 * A future `low` bucket would sink into `total_30d - high_priority_30d`.
 */

const KEY = "csm:zendesk-tickets:v1";
/** Loose email shape — enough to keep a bad interpolation from
 *  breaking the query. Postgres will lower-case-match anyway via
 *  citext, so we're not enforcing RFC here, just guarding against
 *  `'; DROP TABLE`-style typos in a customer's owner_email field. */
const EMAIL_RE = /^[^\s'"@;\\]+@[^\s'"@;\\]+\.[^\s'"@;\\]+$/;

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
 * Sweep counters + recent tickets for a set of {workspace_id,
 * owner_email} pairs. Matches on owner_email — the ticket-filer's
 * user record joins to `users.email`, which is compared against
 * the customer's owner_email from the CSM dashboard. Workspaces
 * without a resolvable owner_email are skipped (no email → no
 * match key).
 *
 * Two Postgres round-trips: counters + a recent-tickets sample via
 * a partitioned ROW_NUMBER window. Merges into whatever's already
 * in the overlay so a partial sweep doesn't wipe the rest.
 */
export async function refreshZendeskOverlay(
  targets: Array<{ workspace_id: string; owner_email: string | null }>,
  opts?: { lookbackDays?: number }
): Promise<ZendeskBlob> {
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  // Build the email → workspace_id map. Emails are lowercased so a
  // customer with "Foo@Bar.com" and a ticket-user with "foo@bar.com"
  // still match on the return trip (Postgres's citext handles the
  // WHERE side; JS is case-sensitive so we normalize here).
  const emailToWs = new Map<string, string>();
  const cleanTargets: Array<{ workspace_id: string; email: string }> = [];
  for (const t of targets) {
    if (!t.workspace_id || !t.owner_email) continue;
    const email = t.owner_email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    if (emailToWs.has(email)) continue; // Two workspaces sharing one owner
    emailToWs.set(email, t.workspace_id);
    cleanTargets.push({ workspace_id: t.workspace_id, email });
  }
  if (cleanTargets.length === 0) {
    return loadZendeskOverlay();
  }
  const arrLit =
    "ARRAY[" +
    cleanTargets.map((t) => `'${t.email.replace(/'/g, "''")}'`).join(",") +
    "]::citext[]";

  const counterSql = `
    SELECT
      u.email::text AS owner_email,
      COUNT(*)::int AS total_30d,
      COUNT(*) FILTER (WHERE zt.priority IN ('high','urgent'))::int AS high_priority_30d,
      COUNT(*) FILTER (WHERE zt.priority = 'urgent')::int AS urgent_30d,
      MAX(zt.created_at)::text AS latest_created_at
    FROM zendesk_tickets zt
    JOIN users u ON u.id = zt.user_id
    WHERE u.email = ANY(${arrLit})
      AND zt.created_at > NOW() - INTERVAL '${lookbackDays} days'
    GROUP BY 1
  `;
  const counterRows = (await runNativeQuery(DB.POSTGRES, counterSql)) as Array<{
    owner_email: string;
    total_30d: number;
    high_priority_30d: number;
    urgent_30d: number;
    latest_created_at: string | null;
  }>;

  const recentSql = `
    SELECT
      zt.owner_email,
      zt.zendesk_id,
      zt.subject,
      zt.priority,
      zt.status,
      zt.created_at::text
    FROM (
      SELECT
        zt.*,
        u.email::text AS owner_email,
        ROW_NUMBER() OVER (
          PARTITION BY u.email
          ORDER BY zt.created_at DESC
        ) AS rn
      FROM zendesk_tickets zt
      JOIN users u ON u.id = zt.user_id
      WHERE u.email = ANY(${arrLit})
        AND zt.created_at > NOW() - INTERVAL '${lookbackDays} days'
    ) zt
    WHERE zt.rn <= ${RECENT_SAMPLE_LIMIT}
    ORDER BY zt.created_at DESC
  `;
  const recentRows = (await runNativeQuery(DB.POSTGRES, recentSql)) as Array<{
    owner_email: string;
    zendesk_id: number;
    subject: string | null;
    priority: string | null;
    status: string | null;
    created_at: string;
  }>;
  const recentByEmail = new Map<string, ZendeskRecentTicket[]>();
  for (const r of recentRows) {
    const email = r.owner_email.toLowerCase();
    const list = recentByEmail.get(email) ?? [];
    list.push({
      zendesk_id: r.zendesk_id,
      subject: r.subject,
      priority: r.priority,
      status: r.status,
      created_at: r.created_at,
    });
    recentByEmail.set(email, list);
  }

  const now = new Date().toISOString();
  const prior = await loadZendeskOverlay();
  // Overlay merge — start from what's already stored so a partial
  // refresh (one CSM's book, or a manual "refresh this workspace"
  // trigger) doesn't blow away rows outside the current batch. Rows
  // that matched get their new values keyed by workspace_id; rows
  // we scanned but that had no tickets in the window get zero-
  // stamped so the chip reads "no tickets" (a positive "clean"
  // signal), not a stale value from a previous spike.
  const rows: Record<string, ZendeskSummary> = { ...prior.rows };
  const hitEmails = new Set<string>();
  for (const r of counterRows) {
    const email = r.owner_email.toLowerCase();
    hitEmails.add(email);
    const workspaceId = emailToWs.get(email);
    if (!workspaceId) continue; // Shouldn't happen — Postgres returned an
    // email we didn't send, or we lost the mapping. Skip defensively.
    rows[workspaceId] = {
      workspace_id: workspaceId,
      total_30d: r.total_30d,
      high_priority_30d: r.high_priority_30d,
      urgent_30d: r.urgent_30d,
      latest_created_at: r.latest_created_at,
      recent: recentByEmail.get(email) ?? [],
      fetched_at: now,
    };
  }
  for (const { workspace_id, email } of cleanTargets) {
    if (hitEmails.has(email)) continue;
    rows[workspace_id] = {
      workspace_id,
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
