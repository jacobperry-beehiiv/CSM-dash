# ADR-0002: The snapshot is AES-encrypted and committed to the repo

**Status:** Accepted · **Baked into:** `src/lib/data/snapshot-crypto.ts`,
`data/snapshot.enc.json`, `SNAPSHOT_ENCRYPTION_KEY`

## Context

[ADR-0001](0001-snapshot-not-live-query.md) makes the book of business a
file. That file contains real customer data (names, ARR, contacts). It
has to be readable by the Vercel runtime and refreshed by a GitHub
Action. Where does it live?

## Decision

Commit it to the repo as an **AES-256-GCM encrypted envelope**
(`data/snapshot.enc.json`). The runtime decrypts on read with a symmetric
key from `SNAPSHOT_ENCRYPTION_KEY`. The plaintext (`data/snapshot.json`)
is gitignored and only produced locally for debugging (`SYNC_PLAINTEXT=1`).

## Why

- **Simplicity.** No external blob store or DB to provision for the
  read-mostly book — it ships with the code and deploys atomically with
  it. Vercel redeploys pick up new data for free.
- **Confidentiality.** The repo is private, but committing plaintext
  customer data is still wrong (clones, forks, local copies, git
  history). Authenticated encryption means the committed file is inert
  without the key.
- **Integrity.** GCM's auth tag means tampering fails the decrypt rather
  than silently serving corrupted data. The `alg` field is stored
  in-envelope to allow future algorithm rotation.

## Consequences

- **The key lives in two places that must stay identical:** Vercel env
  (runtime decrypt) and the GitHub Actions secret (sync-time encrypt).
  Rotating one without the other breaks either the site or the next sync.
- **Don't rotate casually** — old commits become undecryptable. If you
  must, run a fresh sync immediately so the new key has a valid file.
- The key must be **exactly 32 bytes base64** (`getKey()` throws
  otherwise).
