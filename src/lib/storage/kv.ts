import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { isDemoMode } from "../demo/mode";

/**
 * Tiny key-value store. One backend at a time:
 *   - DATABASE_URL set     → Postgres (works on Vercel/Neon/Supabase/anywhere)
 *   - DATABASE_URL unset   → JSON files under data/ (good for local dev)
 *
 * Keys look like `<namespace>/<id>`. Values are JSON-serialisable.
 *
 * Each store (gmail tokens, settings, templates, …) calls into this module
 * — file vs DB is a deploy-time decision, not a code change.
 */

let pgClient: import("postgres").Sql | null = null;
let pgInitPromise: Promise<void> | null = null;

function backend(): "postgres" | "file" {
  return process.env.DATABASE_URL ? "postgres" : "file";
}

async function pg(): Promise<import("postgres").Sql> {
  if (pgClient) return pgClient;
  // Lazy import so the file backend doesn't pay for the postgres bundle.
  const { default: postgres } = await import("postgres");
  pgClient = postgres(process.env.DATABASE_URL!, {
    prepare: false,
    max: 5,
    idle_timeout: 30,
  });
  return pgClient;
}

async function ensureSchema(): Promise<void> {
  if (!pgInitPromise) {
    pgInitPromise = (async () => {
      const sql = await pg();
      await sql`CREATE TABLE IF NOT EXISTS csm_kv (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    })().catch((e) => {
      pgInitPromise = null;
      throw e;
    });
  }
  await pgInitPromise;
}

function fileFor(key: string): string {
  // Allow per-key path overrides (back-compat with env vars set in old stores).
  const safe = key.replace(/[^a-z0-9._/-]/gi, "_");
  return path.join(process.cwd(), "data", `${safe}.json`);
}

export async function kvGet<T>(key: string): Promise<T | null> {
  if (backend() === "postgres") {
    await ensureSchema();
    const sql = await pg();
    const rows = await sql<{ value: T }[]>`
      SELECT value FROM csm_kv WHERE key = ${key} LIMIT 1
    `;
    return rows[0]?.value ?? null;
  }
  try {
    const raw = await readFile(fileFor(key), "utf8");
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  // Demo-mode write guard. Defense in depth — even if a UI action
  // bypasses our front-end checks and calls a write endpoint, the
  // underlying KV mutation no-ops so no real customer data is
  // touched. Local file backend is OK to write to in dev, but we
  // still skip in DEMO_MODE so the fixture stays pure across reloads.
  if (isDemoMode()) return;
  if (backend() === "postgres") {
    await ensureSchema();
    const sql = await pg();
    await sql`
      INSERT INTO csm_kv (key, value, updated_at)
      VALUES (${key}, ${sql.json(value as never)}, now())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    return;
  }
  const file = fileFor(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

export async function kvDelete(key: string): Promise<void> {
  if (isDemoMode()) return;
  if (backend() === "postgres") {
    await ensureSchema();
    const sql = await pg();
    await sql`DELETE FROM csm_kv WHERE key = ${key}`;
    return;
  }
  try {
    await unlink(fileFor(key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Enumerate every key beginning with `prefix`. Rare — most stores
 * know their exact key up front, but per-CSM stores that need a
 * cross-CSM read-side (e.g. "which tag names are already registered
 * by any CSM?") need to scan.
 *
 * Backend behavior:
 *   - Postgres: `SELECT key FROM csm_kv WHERE key LIKE prefix||'%'`.
 *   - File: scans data/<prefix parent> for entries whose sanitized
 *     filename (see fileFor) matches the prefix. Filenames sanitize
 *     `:` and other non-`[a-z0-9._/-]` characters to `_`, so the
 *     scan matches against the sanitized shape of `prefix`.
 *
 * Order is unspecified. Values are NOT returned — callers should
 * kvGet each key they care about. Meant for small (dozens of) key
 * sets; do not use for O(customer) scans.
 */
export async function kvListPrefix(prefix: string): Promise<string[]> {
  if (backend() === "postgres") {
    await ensureSchema();
    const sql = await pg();
    const rows = await sql<{ key: string }[]>`
      SELECT key FROM csm_kv WHERE key LIKE ${prefix + "%"}
    `;
    return rows.map((r) => r.key);
  }
  // File backend: sanitized filenames use `_` in place of `:`, `@`,
  // etc. Reverse the mapping isn't possible in general, so we walk
  // the parent directory of the sanitized prefix and match the
  // sanitized shape. Every read caller in this codebase uses the
  // ORIGINAL (unsanitized) key going forward — file names are an
  // implementation detail of the local dev backend only.
  const sanitizedPrefix = prefix.replace(/[^a-z0-9._/-]/gi, "_");
  const dataDir = path.join(process.cwd(), "data");
  const parent = path.dirname(path.join(dataDir, sanitizedPrefix));
  const basePrefix = path.basename(sanitizedPrefix);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  // We can't perfectly recover the original key from a sanitized
  // filename, so this returns the sanitized form. All current callers
  // treat kvListPrefix output as an opaque set of storage keys they
  // pass to kvGet, which works fine because kvGet re-sanitizes on
  // the file backend. The invariant we rely on: sanitization is
  // idempotent — passing a sanitized key back through fileFor yields
  // the same filename.
  const relParent = path.relative(dataDir, parent);
  return entries
    .filter((f) => f.endsWith(".json") && f.startsWith(basePrefix))
    .map((f) => {
      const stem = f.slice(0, -".json".length);
      return relParent ? `${relParent}/${stem}` : stem;
    });
}

/** True when running against managed Postgres rather than local files. */
export function isPersistentBackend(): boolean {
  return backend() === "postgres";
}
