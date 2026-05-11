import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Customer } from "../types";
import { metabaseRowToCustomer } from "./metabase-mapper";
import { decryptSnapshot, type EncryptedEnvelope } from "./snapshot-crypto";

export interface Snapshot {
  generated_at: string;
  question_id: number;
  row_count: number;
  rows: Record<string, unknown>[];
}

/** Resolves the snapshot file. Prefers the encrypted file if it exists. */
async function resolvePath(snapshotPath?: string): Promise<{
  abs: string;
  encrypted: boolean;
}> {
  const override = snapshotPath ?? process.env.SNAPSHOT_PATH;
  if (override) {
    const abs = path.isAbsolute(override)
      ? override
      : path.join(process.cwd(), override);
    return { abs, encrypted: abs.endsWith(".enc.json") };
  }
  const encrypted = path.join(process.cwd(), "data/snapshot.enc.json");
  const plain = path.join(process.cwd(), "data/snapshot.json");
  // Prefer encrypted if present — that's what we ship in the repo.
  try {
    await stat(encrypted);
    return { abs: encrypted, encrypted: true };
  } catch {
    return { abs: plain, encrypted: false };
  }
}

export async function readSnapshot(snapshotPath?: string): Promise<Snapshot> {
  const { abs, encrypted } = await resolvePath(snapshotPath);

  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `No snapshot at ${abs}. Run \`npm run sync\` to pull the book of business from Metabase.`
      );
    }
    throw e;
  }

  if (encrypted) {
    const envelope = JSON.parse(raw) as EncryptedEnvelope;
    raw = decryptSnapshot(envelope);
  }

  return JSON.parse(raw) as Snapshot;
}

export async function loadCustomersFromSnapshot(
  snapshotPath?: string
): Promise<Customer[]> {
  const snap = await readSnapshot(snapshotPath);
  return snap.rows.map(metabaseRowToCustomer);
}

export async function snapshotMetadata(
  snapshotPath?: string
): Promise<{ generatedAt: string; rowCount: number; ageMs: number } | null> {
  try {
    const { abs } = await resolvePath(snapshotPath);
    const [s, snap] = await Promise.all([stat(abs), readSnapshot(snapshotPath)]);
    return {
      generatedAt: snap.generated_at,
      rowCount: snap.row_count,
      ageMs: Date.now() - s.mtimeMs,
    };
  } catch {
    return null;
  }
}
