import { DB, runNativeQuery } from "../metabase";
import { kvGet, kvSet } from "../storage/kv";
import type { Customer } from "../types";

/**
 * Send-cadence overlay — per-workspace inferred publishing cadence
 * (median days between sends) computed from ClickHouse posts on a
 * daily sweep. Feeds Flag A so a monthly sender isn't flagged after
 * 2 weeks: the threshold becomes `max(override, inferred, 10d) + 14d`.
 *
 * Storage shape mirrors [[hubspot-overlay]]:
 *   • Single KV row keyed `csm:send-cadence:v1`.
 *   • Value: `{ rows: Record<workspace_id, CadenceRow>, fetched_at }`.
 *
 * The overlay only stores INFERRED cadence. The CSM's manual override
 * (`expected_send_cadence_days`) lives on `customer-overrides` KV
 * because it's per-CSM authored, not per-sweep derived.
 *
 * Sample-size floor: we require 3+ sends in the lookback window
 * before publishing a cadence. Two sends gives only one interval,
 * which is unstable for a monthly cadence estimate. Sparse-history
 * workspaces fall through to Flag A's 10-day default.
 */

const KEY = "csm:send-cadence:v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default lookback for cadence inference. 120 days lets us pick up
 *  even a strictly-monthly newsletter (4 sends → 3 intervals → stable
 *  median). Longer windows include stale cadences from before a
 *  publishing-cadence change; shorter ones starve monthly senders. */
export const DEFAULT_LOOKBACK_DAYS = 120;

/** Minimum sends in the lookback window to publish an inferred value.
 *  Two sends = one interval, which is too noisy to base a threshold
 *  relaxation on. */
export const MIN_SAMPLE_SIZE = 3;

export interface CadenceRow {
  workspace_id: string;
  /** Median days between sends over the lookback window. */
  inferred_cadence_days: number;
  /** Number of sends the median was computed from. Surfaced in the
   *  detail-panel tooltip so a CSM can gauge confidence. */
  sample_size: number;
  /** Lookback the sweep used (days). Kept for provenance. */
  lookback_days: number;
  fetched_at: string;
}

export interface CadenceBlob {
  rows: Record<string, CadenceRow>;
  fetched_at: string;
}

export async function loadCadenceOverlay(): Promise<CadenceBlob> {
  const blob = await kvGet<CadenceBlob>(KEY);
  if (!blob) return { rows: {}, fetched_at: new Date(0).toISOString() };
  return blob;
}

export async function saveCadenceOverlay(blob: CadenceBlob): Promise<void> {
  await kvSet<CadenceBlob>(KEY, blob);
}

/** Median of a sorted list of positive numbers. Empty list returns 0
 *  — callers filter these out before publishing a cadence row via
 *  the MIN_SAMPLE_SIZE gate. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compute median inter-send interval per workspace from a list of
 *  (workspace_id, sent_date) rows. Pure — the caller runs the SQL. */
export function computeCadenceRows(
  posts: Array<{ workspace_id: string; sent_date: string }>,
  lookbackDays: number,
  now: Date = new Date()
): Map<string, Omit<CadenceRow, "fetched_at">> {
  const byWorkspace = new Map<string, string[]>();
  for (const p of posts) {
    if (!p.workspace_id || !p.sent_date) continue;
    const arr = byWorkspace.get(p.workspace_id) ?? [];
    arr.push(p.sent_date);
    byWorkspace.set(p.workspace_id, arr);
  }

  const nowMs = now.getTime();
  const out = new Map<string, Omit<CadenceRow, "fetched_at">>();
  for (const [workspaceId, dateStrs] of byWorkspace.entries()) {
    if (dateStrs.length < MIN_SAMPLE_SIZE) continue;
    // Dedupe same-day sends — bursty send days shouldn't collapse
    // the median to zero. A workspace that publishes twice on a
    // single day and then once next week has cadence 7d not 0d.
    const uniqueDays = Array.from(new Set(dateStrs.map((d) => d.slice(0, 10))));
    if (uniqueDays.length < MIN_SAMPLE_SIZE) continue;
    const sorted = uniqueDays
      .map((d) => new Date(`${d}T00:00:00Z`).getTime())
      .filter((t) => !isNaN(t))
      .sort((a, b) => a - b);
    if (sorted.length < MIN_SAMPLE_SIZE) continue;

    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const diffDays = (sorted[i] - sorted[i - 1]) / (1000 * 60 * 60 * 24);
      if (diffDays > 0) intervals.push(diffDays);
    }
    if (intervals.length === 0) continue;

    // Also consider the "gap since last send" as a bounding signal —
    // when a workspace has slowed down (last send was 60d ago but
    // historical median is 7d), we don't want to keep the old 7d
    // cadence locked in and flag them for it. The threshold formula
    // in Flag A already handles the "no send > cadence + 14d" case,
    // so we just publish the historical median and let the flag
    // decide.
    intervals.sort((a, b) => a - b);
    const med = median(intervals);

    // Discard trivially small medians (e.g., every send on the same
    // day due to timezone weirdness). Anything < 1 day rounds to 1
    // — the threshold ends up being 15d (1 + 14) which lands us at
    // roughly the old fixed default for daily senders, keeping the
    // behavior stable for them.
    const rounded = Math.max(1, Math.round(med));

    out.set(workspaceId, {
      workspace_id: workspaceId,
      inferred_cadence_days: rounded,
      sample_size: uniqueDays.length,
      lookback_days: lookbackDays,
    });
    // Ensure `nowMs` is referenced so a future refactor to gate on
    // "sample recency" has the value available; also documents that
    // we intentionally do NOT decay the median with the age of the
    // sample here.
    void nowMs;
  }
  return out;
}

/** Fetch send dates for a set of workspaces from ClickHouse. Uses the
 *  same posts-table shape as [[wins-metrics]] but only reads the
 *  scheduled_at date + workspace_id. */
export async function fetchSendDates(
  workspaceIds: string[],
  lookbackDays: number
): Promise<Array<{ workspace_id: string; sent_date: string }>> {
  const filtered = workspaceIds.filter((id) => UUID_RE.test(id));
  if (filtered.length === 0) return [];
  const inClause = filtered
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(",");
  const sql = `
    SELECT
      toString(o.id) AS workspace_id,
      toString(toDate(p.scheduled_at)) AS sent_date
    FROM swarm_clickpipes.organizations o
    JOIN swarm_clickpipes.publications pub ON o.id = pub.organization_id
    JOIN swarm_clickpipes.posts p ON pub.id = p.publication_id
    WHERE o.id IN (${inClause})
      AND p.send_status = 2
      AND p.scheduled_at >= now() - INTERVAL ${lookbackDays} DAY
      AND p.scheduled_at < toDate(now())
    ORDER BY p.scheduled_at ASC
  `;
  const rows = (await runNativeQuery(DB.CLICKHOUSE_ADHOC, sql)) as unknown as Array<
    { workspace_id: string; sent_date: string }
  >;
  return rows;
}

/** Drop overlay rows for workspace_ids absent from `keep`. Mirrors
 *  [[hubspot-overlay]]'s prune so customers churned out of the book
 *  don't leave stale cadence rows lying around. */
export async function pruneCadenceOverlay(keep: Set<string>): Promise<number> {
  const blob = await loadCadenceOverlay();
  let removed = 0;
  for (const id of Object.keys(blob.rows)) {
    if (!keep.has(id)) {
      delete blob.rows[id];
      removed++;
    }
  }
  if (removed > 0) {
    blob.fetched_at = new Date().toISOString();
    await saveCadenceOverlay(blob);
  }
  return removed;
}

/** Merge cadence overlay onto in-memory customer rows. Pure — returns
 *  a new array. Rows without a workspace_id (test customer) or without
 *  a cadence overlay row pass through unchanged. */
export function mergeCadenceInto(
  customers: Customer[],
  overlay: CadenceBlob
): Customer[] {
  if (Object.keys(overlay.rows).length === 0) return customers;
  return customers.map((c) => {
    if (!c.workspace_id) return c;
    const row = overlay.rows[c.workspace_id];
    if (!row) return c;
    return {
      ...c,
      inferred_cadence_days: row.inferred_cadence_days,
      inferred_cadence_updated_at: row.fetched_at,
      inferred_cadence_sample_size: row.sample_size,
    };
  });
}
