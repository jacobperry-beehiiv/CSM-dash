import { kvGet, kvSet } from "../storage/kv";
import {
  TREND_RERAISE_DAYS,
  TREND_RERAISE_SEVERITY_DELTA,
  type TrendClear,
  type TrendClearMap,
} from "../engines/engagement-trends-types";

/**
 * "I've looked at this decline" dismissals, keyed by workspace_id.
 *
 * Keyed at the WORKSPACE, not the publication, because that's the unit
 * the warning is shown on (a red row in the All assigned table) and
 * therefore the unit a CSM is actually dismissing. Clearing a single
 * newsletter while its six siblings keep the row red would be a
 * confusing thing to offer.
 *
 * ─── Why these expire and deliverability clears don't ───
 *
 * `deliverability-clears` can be permanent: it's keyed by post_id, and
 * the next send is a different post that trips fresh. A trend has no
 * such natural reset. A permanent clear would silence a publication
 * that goes on sliding for another ten points — precisely the failure
 * this whole report exists to prevent.
 *
 * So a clear records the severity at dismissal, and the row comes back
 * when things get materially worse (TREND_RERAISE_SEVERITY_DELTA). Ack
 * a 40 and it stays quiet through 55; at 60 it's a new situation and
 * you should hear about it again.
 *
 * No module-level cache, same reasoning as flag-resolutions: a warm
 * Vercel isolate holding a stale map makes a dismissal appear to
 * revert on the next page load from a different isolate.
 */

const KEY = "trend-clears";

export async function loadTrendClears(): Promise<TrendClearMap> {
  return (await kvGet<TrendClearMap>(KEY)) ?? {};
}

export async function clearTrend(
  workspaceId: string,
  severityAtClear: number,
  meta: { clearedBy?: string | null; reason?: string | null } = {}
): Promise<TrendClearMap> {
  const map = { ...(await loadTrendClears()) };
  map[workspaceId] = {
    cleared_at: new Date().toISOString(),
    cleared_by: meta.clearedBy ?? null,
    reason: meta.reason ?? null,
    severity_at_clear: severityAtClear,
  };
  await kvSet(KEY, map);
  return map;
}

export async function unclearTrend(
  workspaceId: string
): Promise<TrendClearMap> {
  const map = { ...(await loadTrendClears()) };
  delete map[workspaceId];
  await kvSet(KEY, map);
  return map;
}

/**
 * Is this workspace's warning currently silenced?
 *
 * Pure so it can run on either side of the wire — the API route uses
 * it to filter, and the client uses it to decide whether a row is red
 * without a second round trip.
 */
export function isTrendCleared(
  clear: TrendClear | undefined,
  currentSeverity: number,
  now: Date = new Date()
): boolean {
  if (!clear) return false;

  // Age backstop first. Severity tops out at 100, so the delta rule
  // below can never fire for anything cleared above 80 — without this,
  // the most severe declines would be the ones muted permanently.
  const ageDays =
    (now.getTime() - new Date(clear.cleared_at).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays >= TREND_RERAISE_DAYS) return false;

  return currentSeverity < clear.severity_at_clear + TREND_RERAISE_SEVERITY_DELTA;
}
