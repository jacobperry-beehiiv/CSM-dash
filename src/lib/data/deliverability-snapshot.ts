import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  decryptSnapshot,
  encryptSnapshot,
  type EncryptedEnvelope,
} from "./snapshot-crypto";
import type { PostMetricsRow } from "../types";

/**
 * Read/write for the deliverability snapshot — pre-computed Enterprise
 * post metrics for the last N days, written by scripts/sync.ts so the
 * /csm Deliverability tab doesn't have to fire 4 ClickHouse queries on
 * every cold isolate.
 *
 * Why a dedicated module: the deliverability payload has different
 * metadata from the AM cohort snapshots (lookback window instead of a
 * Metabase question id) and the rows are already typed
 * (PostMetricsRow), so it pays its way to give it a typed read path.
 *
 * Same encryption + on-disk layout as snapshot.enc.json — encrypted
 * preferred in production, plaintext fallback for SYNC_PLAINTEXT=1
 * local debugging.
 */

const BASENAME = "deliverability";

export interface DeliverabilitySnapshotPayload {
  generated_at: string;
  lookback_days: number;
  row_count: number;
  posts: PostMetricsRow[];
  /**
   * Dates (YYYY-MM-DD) where the spam-reports column on each row
   * reflects a fresh Q4 query at sync time. The engine reads this to
   * decide whether to skip the runtime spam-overlay for a given
   * target_date — when the date is in this list, the snapshot
   * already has authoritative spam counts and we can render without
   * touching ClickHouse.
   *
   * Older dates (or dates the sync skipped/failed) aren't here; the
   * runtime path falls back to a live overlay for those (with a hard
   * timeout so the page can't hang).
   */
  spam_dates: string[];
}

async function resolvePath(): Promise<{
  abs: string;
  encrypted: boolean;
} | null> {
  const encrypted = path.join(process.cwd(), `data/${BASENAME}.enc.json`);
  const plain = path.join(process.cwd(), `data/${BASENAME}.json`);
  try {
    await stat(encrypted);
    return { abs: encrypted, encrypted: true };
  } catch {
    /* not present */
  }
  try {
    await stat(plain);
    return { abs: plain, encrypted: false };
  } catch {
    return null;
  }
}

/**
 * Read the deliverability snapshot. Returns `null` (rather than
 * throwing) when the file is missing so the engine can fall back to a
 * live ClickHouse fetch in environments that haven't synced yet.
 */
export async function readDeliverabilitySnapshot(): Promise<DeliverabilitySnapshotPayload | null> {
  const resolved = await resolvePath();
  if (!resolved) return null;

  let raw: string;
  try {
    raw = await readFile(resolved.abs, "utf8");
  } catch {
    return null;
  }

  if (resolved.encrypted) {
    try {
      const envelope = JSON.parse(raw) as EncryptedEnvelope;
      raw = decryptSnapshot(envelope);
    } catch (e) {
      console.error(
        "[deliverability-snapshot] decrypt failed:",
        e instanceof Error ? e.message : e
      );
      return null;
    }
  }

  try {
    return JSON.parse(raw) as DeliverabilitySnapshotPayload;
  } catch (e) {
    console.error(
      "[deliverability-snapshot] JSON parse failed:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

/**
 * Persist the deliverability snapshot. Used by scripts/sync.ts. Writes
 * data/deliverability.enc.json by default; pass `{ plaintext: true }`
 * for the gitignored debugging variant.
 */
export async function writeDeliverabilitySnapshot(
  payload: DeliverabilitySnapshotPayload,
  options: { plaintext?: boolean } = {}
): Promise<string> {
  const filename = options.plaintext
    ? `data/${BASENAME}.json`
    : `data/${BASENAME}.enc.json`;
  const abs = path.join(process.cwd(), filename);
  await mkdir(path.dirname(abs), { recursive: true });

  if (options.plaintext) {
    await writeFile(abs, JSON.stringify(payload, null, 2), "utf8");
  } else {
    const envelope = encryptSnapshot(JSON.stringify(payload));
    await writeFile(abs, JSON.stringify(envelope, null, 2), "utf8");
  }
  return abs;
}
