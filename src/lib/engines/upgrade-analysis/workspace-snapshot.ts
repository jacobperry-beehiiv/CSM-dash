/**
 * Workspace-wide D&C Deliverability Snapshot.
 *
 * Reuses the exact same 7-metric flag table used by the single-pub
 * snapshot tile, but computed for every publication under an
 * organization plus an aggregate row on top. Denominator-weighted:
 * the aggregate row sums raw counters across all pubs, then applies
 * the fixed D&C ratios — so a workspace with one huge pub isn't
 * skewed by a 200-sub side pub's noise. Matches what a D&C reviewer
 * would compute by hand when triaging a whole account.
 *
 * SQL shape:
 *   1. Pull publication_id + name + total subs from Postgres for the org.
 *   2. One ClickHouse query grouped by publication_id, over the window,
 *      returning the raw funnel counters per pub.
 *   3. One Postgres query grouped by publication_id for unsub counts.
 *   4. Fold everything into per-pub FunnelCounters and compute the
 *      snapshots via the same `computeDeliverabilitySnapshot` used by
 *      the single-pub tile.
 *   5. Sum funnel counters into an aggregate FunnelCounters and run
 *      the snapshot function once more for the aggregate row.
 *
 * All queries are wrapped in withTimeout and fail open — a stuck
 * ClickHouse doesn't fail the whole panel, the affected pub just
 * returns as `no_data`.
 */

import { DB, runNativeQuery } from "../../metabase";
import type {
  AnalysisWindow,
  FunnelCounters,
  WorkspaceSnapshot,
  WorkspaceSnapshotPubRow,
} from "./types";
import { computeDeliverabilitySnapshot } from "./rules";

// ─── Shared query utilities ──────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 45_000;

function q(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[workspace-snapshot] ${label} timed out after ${ms}ms — falling back`
      );
      resolve(fallback);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        console.warn(
          `[workspace-snapshot] ${label} errored:`,
          err instanceof Error ? err.message : err
        );
        resolve(fallback);
      }
    );
  });
}

/** ClickHouse timestamp filter for the analysis window. Duplicated
 *  intentionally from pillars.ts: keeping this file free of engine
 *  imports lets it be exercised from the workspace endpoint without
 *  dragging the whole scan pipeline in. */
function chWindowClause(
  window: AnalysisWindow | undefined,
  fallbackDays: number
): { clause: string; effectiveDays: number } {
  if (!window) {
    return {
      clause: `\`timestamp\` >= now() - INTERVAL ${fallbackDays} DAY`,
      effectiveDays: fallbackDays,
    };
  }
  if (window.kind === "lookback") {
    return {
      clause: `\`timestamp\` >= now() - INTERVAL ${window.lookback_days} DAY`,
      effectiveDays: window.lookback_days,
    };
  }
  const startMs = Date.parse(`${window.start_date}T00:00:00Z`);
  const endMs = Date.parse(`${window.end_date}T00:00:00Z`);
  const effectiveDays =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
      ? Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1)
      : fallbackDays;
  return {
    clause: `\`timestamp\` >= toDateTime('${window.start_date} 00:00:00') AND \`timestamp\` <= toDateTime('${window.end_date} 23:59:59')`,
    effectiveDays,
  };
}

function pgWindowClause(
  window: AnalysisWindow | undefined,
  fallbackDays: number
): string {
  if (!window || window.kind === "lookback") {
    const days = window ? window.lookback_days : fallbackDays;
    return `unsubscribed_at >= now() - INTERVAL '${days} days'`;
  }
  return `unsubscribed_at >= '${window.start_date} 00:00:00' AND unsubscribed_at <= '${window.end_date} 23:59:59'`;
}

// ─── Postgres: publication list ──────────────────────────────────────────

interface PubMetaRow {
  id: string;
  name: string | null;
  subscribers: number | null;
}

async function fetchPublicationsForOrg(
  organizationId: string
): Promise<PubMetaRow[]> {
  // We fetch subscribers via a lateral count; the base publications
  // table gives us id + name. Publications marked deleted are still
  // listed so a D&C reviewer can see historical send patterns —
  // hiding them would mask sending pubs that just got soft-deleted.
  const sql = `
    SELECT p.id, p.name,
      (SELECT COUNT(*)::int FROM subscriptions s
        WHERE s.publication_id = p.id AND s.unsubscribed_at IS NULL) AS subscribers
    FROM publications p
    WHERE p.organization_id = ${q(organizationId)}
    ORDER BY subscribers DESC NULLS LAST, p.created_at DESC
    LIMIT 200
  `;
  const rows = (await withTimeout(
    runNativeQuery(DB.POSTGRES, sql) as Promise<unknown[]>,
    QUERY_TIMEOUT_MS,
    [] as unknown[],
    "pubs-list"
  )) as PubMetaRow[];
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name == null ? null : String(r.name),
    subscribers: r.subscribers == null ? null : Number(r.subscribers),
  }));
}

// ─── ClickHouse: batch funnel per publication ────────────────────────────

interface CHRow {
  publication_id: string;
  rows_evt: number;
  sent: number;
  deliv: number;
  opens: number;
  v_opens: number;
  mach_opens: number;
  ua_mach: number;
  clicks: number;
  v_clicks: number;
  deferred: number;
  soft_b: number;
  hard_b: number;
  spam: number;
  uniq_subs: number;
}

async function fetchFunnelPerPub(
  pubIds: string[],
  clause: string
): Promise<Map<string, Omit<CHRow, "publication_id">>> {
  if (pubIds.length === 0) return new Map();
  // Comma-separate the ids for the IN clause; each is single-quoted
  // via `q()`.
  const inList = pubIds.map(q).join(",");
  const sql = `
    SELECT publication_id,
      count() AS rows_evt,
      countIf(\`event\` = 'processed') AS sent,
      sum(\`is_delivered\`) AS deliv,
      sum(\`is_opened\`) AS opens,
      sum(\`is_verified_opened\`) AS v_opens,
      sum(\`sg_machine_open\`) AS mach_opens,
      sum(\`ua_suspected_machine\`) AS ua_mach,
      sum(\`is_clicked\`) AS clicks,
      sum(\`is_verified_clicked\`) AS v_clicks,
      sum(\`is_deferred\`) AS deferred,
      sum(\`is_soft_bounced\`) AS soft_b,
      sum(\`is_hard_bounced\`) AS hard_b,
      sum(\`is_spam_reported\`) AS spam,
      uniqExact(\`subscriber_id\`) AS uniq_subs
    FROM default.sendgrid_v1
    WHERE publication_id IN (${inList})
      AND ${clause}
    GROUP BY publication_id
  `;
  const rows = (await withTimeout(
    runNativeQuery(DB.CLICKHOUSE_MAIN, sql) as Promise<unknown[]>,
    QUERY_TIMEOUT_MS,
    [] as unknown[],
    "funnel-per-pub"
  )) as CHRow[];
  const map = new Map<string, Omit<CHRow, "publication_id">>();
  for (const r of rows) {
    map.set(String(r.publication_id), {
      rows_evt: Number(r.rows_evt ?? 0),
      sent: Number(r.sent ?? 0),
      deliv: Number(r.deliv ?? 0),
      opens: Number(r.opens ?? 0),
      v_opens: Number(r.v_opens ?? 0),
      mach_opens: Number(r.mach_opens ?? 0),
      ua_mach: Number(r.ua_mach ?? 0),
      clicks: Number(r.clicks ?? 0),
      v_clicks: Number(r.v_clicks ?? 0),
      deferred: Number(r.deferred ?? 0),
      soft_b: Number(r.soft_b ?? 0),
      hard_b: Number(r.hard_b ?? 0),
      spam: Number(r.spam ?? 0),
      uniq_subs: Number(r.uniq_subs ?? 0),
    });
  }
  return map;
}

// ─── Postgres: batch unsub count per publication ─────────────────────────

interface UnsubRow {
  publication_id: string;
  unsubs: number;
}

async function fetchUnsubsPerPub(
  pubIds: string[],
  windowClause: string
): Promise<Map<string, number>> {
  if (pubIds.length === 0) return new Map();
  const inList = pubIds.map(q).join(",");
  const sql = `
    SELECT publication_id, COUNT(*)::int AS unsubs
    FROM subscriptions
    WHERE publication_id IN (${inList})
      AND unsubscribed_at IS NOT NULL
      AND ${windowClause}
    GROUP BY publication_id
  `;
  const rows = (await withTimeout(
    runNativeQuery(DB.POSTGRES, sql) as Promise<unknown[]>,
    QUERY_TIMEOUT_MS,
    [] as unknown[],
    "unsubs-per-pub"
  )) as UnsubRow[];
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(String(r.publication_id), Number(r.unsubs ?? 0));
  }
  return map;
}

// ─── Orchestrator ────────────────────────────────────────────────────────

const DEFAULT_LOOKBACK_DAYS = 30;

export async function runWorkspaceSnapshot(
  organizationId: string,
  window?: AnalysisWindow
): Promise<WorkspaceSnapshot> {
  const { clause, effectiveDays } = chWindowClause(window, DEFAULT_LOOKBACK_DAYS);
  const pgClause = pgWindowClause(window, DEFAULT_LOOKBACK_DAYS);

  const pubs = await fetchPublicationsForOrg(organizationId);
  const pubIds = pubs.map((p) => p.id);

  const [funnelMap, unsubMap] = await Promise.all([
    fetchFunnelPerPub(pubIds, clause),
    fetchUnsubsPerPub(pubIds, pgClause),
  ]);

  const rows: WorkspaceSnapshotPubRow[] = pubs.map((p) => {
    const funnel = mkFunnel(effectiveDays, funnelMap.get(p.id), unsubMap.get(p.id));
    return {
      pub_id: p.id,
      name: p.name,
      subscribers: p.subscribers,
      funnel,
      snapshot: computeDeliverabilitySnapshot(funnel),
    };
  });

  const aggregateFunnel = sumFunnels(effectiveDays, rows.map((r) => r.funnel));
  const aggregate = computeDeliverabilitySnapshot(aggregateFunnel);

  return {
    organization_id: organizationId,
    window_days: effectiveDays,
    analysis_window: window ?? null,
    aggregate,
    aggregate_funnel: aggregateFunnel,
    rows,
    generated_at: new Date().toISOString(),
  };
}

// ─── Local helpers ───────────────────────────────────────────────────────

function mkFunnel(
  windowDays: number,
  ch: Omit<CHRow, "publication_id"> | undefined,
  unsubs: number | undefined
): FunnelCounters {
  const processed = ch ? ch.sent : 0;
  const deliv = ch ? ch.deliv : 0;
  const softB = ch ? ch.soft_b : 0;
  const hardB = ch ? ch.hard_b : 0;
  // Same fallback logic as the single-pub funnel pillar — use
  // processed events when present, otherwise the delivered + bounced
  // terminal-state sum, which represents what was actually sent.
  const sent = processed > 0 ? processed : deliv + softB + hardB;
  return {
    window_days: windowDays,
    rows_evt: ch?.rows_evt ?? 0,
    sent,
    deliv,
    opens: ch?.opens ?? 0,
    v_opens: ch?.v_opens ?? 0,
    mach_opens: ch?.mach_opens ?? 0,
    ua_mach: ch?.ua_mach ?? 0,
    clicks: ch?.clicks ?? 0,
    v_clicks: ch?.v_clicks ?? 0,
    deferred: ch?.deferred ?? 0,
    soft_b: softB,
    hard_b: hardB,
    spam: ch?.spam ?? 0,
    uniq_subs: ch?.uniq_subs ?? 0,
    unsubs: unsubs ?? 0,
  };
}

function sumFunnels(
  windowDays: number,
  funnels: FunnelCounters[]
): FunnelCounters {
  const acc: FunnelCounters = {
    window_days: windowDays,
    rows_evt: 0,
    sent: 0,
    deliv: 0,
    opens: 0,
    v_opens: 0,
    mach_opens: 0,
    ua_mach: 0,
    clicks: 0,
    v_clicks: 0,
    deferred: 0,
    soft_b: 0,
    hard_b: 0,
    spam: 0,
    // uniqExact isn't associative across pubs — summing unique
    // subscriber counts across pubs double-counts anyone subscribed
    // to multiple pubs. Reported as a rough upper bound; the D&C
    // ratios don't depend on it.
    uniq_subs: 0,
    unsubs: 0,
  };
  for (const f of funnels) {
    acc.rows_evt += f.rows_evt;
    acc.sent += f.sent;
    acc.deliv += f.deliv;
    acc.opens += f.opens;
    acc.v_opens += f.v_opens;
    acc.mach_opens += f.mach_opens;
    acc.ua_mach += f.ua_mach;
    acc.clicks += f.clicks;
    acc.v_clicks += f.v_clicks;
    acc.deferred += f.deferred;
    acc.soft_b += f.soft_b;
    acc.hard_b += f.hard_b;
    acc.spam += f.spam;
    acc.uniq_subs += f.uniq_subs;
    acc.unsubs += f.unsubs;
  }
  return acc;
}
