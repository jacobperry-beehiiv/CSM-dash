import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Customer } from "../types";
import { metabaseRowToCustomer } from "./metabase-mapper";

export interface Snapshot {
  generated_at: string;
  question_id: number;
  row_count: number;
  rows: Record<string, unknown>[];
}

export async function readSnapshot(snapshotPath?: string): Promise<Snapshot> {
  const file =
    snapshotPath ?? process.env.SNAPSHOT_PATH ?? "data/snapshot.json";
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);

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
    const file =
      snapshotPath ?? process.env.SNAPSHOT_PATH ?? "data/snapshot.json";
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
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
