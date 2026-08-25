# ADR-0003: One KV abstraction (Postgres in prod, files in dev)

**Status:** Accepted · **Baked into:** `src/lib/storage/kv.ts`

## Context

Everything mutable — settings, overrides, templates, review states,
per-CSM state, Gmail tokens, flag resolutions — needs persistence. The
app runs on Vercel serverless (needs a real DB) but should also run
locally with zero setup.

## Decision

A single key/value primitive, `kvGet`/`kvSet`/`kvDelete`, over one of two
backends chosen at runtime by whether `DATABASE_URL` is set:

- **Prod:** Postgres, one table `csm_kv (key TEXT PK, value JSONB, updated_at)`.
- **Dev:** JSON files under `data/<key>.json`.

Backend selection is a **deploy-time decision, never a code change**.
Keys use `csm:<feature>:v1`.

## Why

- **Zero-config local dev.** No local Postgres required; state is just
  files you can inspect and `rm`.
- **One schema for everything.** JSONB blobs mean a new feature is a new
  key, not a migration. The `:v1` suffix is a manual version escape hatch
  (bump to `:v2` to abandon a shape).
- **Serverless-friendly.** Lazy-imported `postgres` driver, small pool
  (`max:5`), idempotent `ensureSchema()`.

## Consequences

- **No relational queries or transactions** — it's a blob store. Features
  that need cross-row consistency don't get it; design around
  single-row read-modify-write.
- **No locking → lost updates.** Two concurrent writers to the same key
  clobber each other. Keep per-CSM/-workspace blobs small and use batch
  mutators for bulk edits.
- **Module caches over blobs are a footgun** across warm isolates — see
  [ADR-0004](0004-no-cache-on-mutable-stores.md).
- `kvSet`/`kvDelete` **no-op in `DEMO_MODE`** (defense in depth); `kvGet`
  is not guarded.
- The file backend is **dev-only** (not safe on serverless — no shared
  filesystem).
