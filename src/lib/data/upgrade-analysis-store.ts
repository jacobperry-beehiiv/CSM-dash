import { kvGet, kvSet } from "../storage/kv";
import type {
  StoredUpgradeAnalysis,
  UpgradeAnalysisReport,
} from "../engines/upgrade-analysis/types";

/**
 * KV store for D&C Upgrade Analysis reports. Blob is keyed by
 * publication_id — one row per pub, holding the latest scan + its
 * timestamp. Report volume is small (dozens to hundreds of pubs),
 * so we keep everything in one KV row for a single-read
 * render on the review-queue tab.
 *
 * No module-level cache — a warm isolate on Vercel could otherwise
 * serve a stale scan to a CSM whose colleague just re-ran the
 * scorecard on another isolate. Same posture as wins-store.
 */

const KEY = "csm:upgrade-analysis:v1";

interface Blob {
  reports: Record<string, StoredUpgradeAnalysis>;
  fetched_at: string;
}

const EMPTY: Blob = { reports: {}, fetched_at: "" };

async function loadBlob(): Promise<Blob> {
  const blob = await kvGet<Blob>(KEY);
  if (!blob) return { ...EMPTY, fetched_at: new Date().toISOString() };
  return { ...blob, fetched_at: new Date().toISOString() };
}

async function saveBlob(blob: Blob): Promise<void> {
  await kvSet(KEY, blob);
}

/** Fetch every stored scan — used by the review-queue tab (one KV
 *  read renders the whole D&C queue). Filtering to `escalation.needed`
 *  happens in the caller. */
export async function loadAllUpgradeAnalyses(): Promise<StoredUpgradeAnalysis[]> {
  const blob = await loadBlob();
  return Object.values(blob.reports);
}

/** Fetch one pub's stored scan, or null when we've never scanned it. */
export async function loadUpgradeAnalysis(
  publicationId: string
): Promise<StoredUpgradeAnalysis | null> {
  const blob = await loadBlob();
  return blob.reports[publicationId] ?? null;
}

/** Upsert a fresh report, stamping `last_scanned_at`. */
export async function saveUpgradeAnalysis(
  report: UpgradeAnalysisReport
): Promise<StoredUpgradeAnalysis> {
  const blob = await loadBlob();
  const stored: StoredUpgradeAnalysis = {
    report,
    last_scanned_at: new Date().toISOString(),
  };
  blob.reports[report.pub_id] = stored;
  await saveBlob(blob);
  return stored;
}

/** True iff a scan exists and its `last_scanned_at` is within the
 *  freshness window. Guards against accidental double-clicks racking
 *  up ClickHouse cost — see the freshness-guard verification step. */
export function isReportFresh(
  stored: StoredUpgradeAnalysis | null,
  freshnessHours: number,
  now: Date = new Date()
): boolean {
  if (!stored) return false;
  const scannedAt = Date.parse(stored.last_scanned_at);
  if (isNaN(scannedAt)) return false;
  const ageMs = now.getTime() - scannedAt;
  return ageMs < freshnessHours * 60 * 60 * 1000;
}

/** Drop reports whose scans are older than N days. Manual maintenance
 *  helper — no cron calls it in MVP, but D&C can trim from a curl if
 *  the blob grows. */
export async function pruneOlderThan(days: number): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const blob = await loadBlob();
  const kept: Record<string, StoredUpgradeAnalysis> = {};
  let pruned = 0;
  for (const [id, stored] of Object.entries(blob.reports)) {
    const ts = Date.parse(stored.last_scanned_at);
    if (isNaN(ts) || ts >= cutoff) {
      kept[id] = stored;
    } else {
      pruned++;
    }
  }
  if (pruned === 0) return 0;
  blob.reports = kept;
  await saveBlob(blob);
  return pruned;
}
