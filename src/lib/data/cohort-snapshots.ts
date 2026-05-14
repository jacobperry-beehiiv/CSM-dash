import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  decryptSnapshot,
  encryptSnapshot,
  type EncryptedEnvelope,
} from "./snapshot-crypto";

/**
 * Generic read/write for "cohort" snapshots — pre-computed Metabase
 * query results that the daily sync writes once and the dashboard
 * reads at runtime. Same on-disk layout as the main customer
 * snapshot, just one file per cohort.
 *
 * Why separate files: the customer snapshot is the lookup table for
 * literally every page. The AM cohort questions (q13268, q24620) only
 * matter on /am — keeping them in their own envelope means a corrupt
 * or stale cohort file doesn't risk knocking out the main book.
 *
 * Files live in `data/<name>.enc.json` and follow the same
 * encrypted-preferred / plaintext-fallback resolution as the main
 * snapshot. The encrypted form is what we commit to git; the plaintext
 * form is gitignored and only used when SYNC_PLAINTEXT=1 is set
 * locally for debugging.
 */

export interface CohortSnapshotPayload {
  generated_at: string;
  question_id: number;
  row_count: number;
  rows: Record<string, unknown>[];
}

/**
 * Resolve the path to a cohort snapshot. Prefers the encrypted form
 * (`<basename>.enc.json`) over the plaintext (`<basename>.json`) so
 * production deploys always read the committed encrypted file.
 */
async function resolveCohortPath(basename: string): Promise<{
  abs: string;
  encrypted: boolean;
} | null> {
  const encrypted = path.join(process.cwd(), `data/${basename}.enc.json`);
  const plain = path.join(process.cwd(), `data/${basename}.json`);
  try {
    await stat(encrypted);
    return { abs: encrypted, encrypted: true };
  } catch {
    // fall through to plaintext
  }
  try {
    await stat(plain);
    return { abs: plain, encrypted: false };
  } catch {
    return null;
  }
}

/**
 * Read a cohort snapshot from disk. Returns `null` (rather than throwing)
 * when the file doesn't exist — callers fall back to a live Metabase
 * fetch in that case, so the dashboard keeps working in environments
 * that haven't run sync yet.
 */
export async function readCohortSnapshot(
  basename: string
): Promise<CohortSnapshotPayload | null> {
  const resolved = await resolveCohortPath(basename);
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
        `[cohort-snapshots] decrypt failed for ${basename}:`,
        e instanceof Error ? e.message : e
      );
      return null;
    }
  }

  try {
    return JSON.parse(raw) as CohortSnapshotPayload;
  } catch (e) {
    console.error(
      `[cohort-snapshots] JSON parse failed for ${basename}:`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

/**
 * Persist a cohort snapshot. Used by scripts/sync.ts. Writes to
 * data/<basename>.enc.json by default; pass `{ plaintext: true }` for
 * the gitignored debugging variant (`data/<basename>.json`).
 */
export async function writeCohortSnapshot(
  basename: string,
  payload: CohortSnapshotPayload,
  options: { plaintext?: boolean } = {}
): Promise<string> {
  const filename = options.plaintext
    ? `data/${basename}.json`
    : `data/${basename}.enc.json`;
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
