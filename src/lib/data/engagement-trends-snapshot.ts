import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  decryptSnapshot,
  encryptSnapshot,
  type EncryptedEnvelope,
} from "./snapshot-crypto";
import type { EngagementTrendReport } from "../engines/engagement-trends-types";

/**
 * Read/write for the engagement-trend snapshot.
 *
 * Same on-disk layout and encryption as the deliverability snapshot,
 * and it exists for a sharper version of the same reason: a live run
 * of `runEngagementTrends()` fires 39 ClickHouse queries and takes
 * minutes. That is fine on a scheduled sweep and impossible on a page
 * request, so the report is pre-computed and the dashboard only ever
 * reads this file.
 *
 * Returns null when absent. Callers render the empty state rather than
 * falling back to a live run — unlike deliverability, the live path
 * here is far too slow to serve a request, so there is deliberately no
 * fallback to accidentally trigger.
 */

const BASENAME = "engagement-trends";

export interface EngagementTrendsSnapshotPayload extends EngagementTrendReport {
  /** Publications the sweep actually scored, for the freshness line. */
  publications_examined: number;
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

export async function readEngagementTrendsSnapshot(): Promise<EngagementTrendsSnapshotPayload | null> {
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
        "[engagement-trends-snapshot] decrypt failed:",
        e instanceof Error ? e.message : e
      );
      return null;
    }
  }

  try {
    return JSON.parse(raw) as EngagementTrendsSnapshotPayload;
  } catch (e) {
    console.error(
      "[engagement-trends-snapshot] JSON parse failed:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

export async function writeEngagementTrendsSnapshot(
  payload: EngagementTrendsSnapshotPayload,
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
