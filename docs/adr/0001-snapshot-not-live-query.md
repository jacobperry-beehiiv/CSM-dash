# ADR-0001: Book of business is a twice-daily snapshot, not a live query

**Status:** Accepted · **Decision baked into:** `DATA_SOURCE` default,
`scripts/sync.ts`, `.github/workflows/sync-data.yml`

## Context

The book of business is Metabase question **q10600**. The dashboard could
read it live on every page load (`DATA_SOURCE=metabase`) or from a
pre-pulled snapshot (`DATA_SOURCE=snapshot`).

## Decision

Default to a **snapshot**: a GitHub Action runs `npm run sync` twice a
day (cron `0 8,16 * * *`), pulls q10600 (plus enrichment), and commits an
encrypted `data/snapshot.enc.json` back to `main`. Vercel redeploys on
the commit. Live Metabase mode still exists behind the env flag for local
work.

## Why

- **Latency & load.** q10600 is a heavy join; running it per page load
  (and per engine, per cron) would be slow and hammer Metabase.
- **Auth.** Metabase access is behind SSO/API keys not every runtime
  path should carry; a committed snapshot decouples the runtime from
  Metabase availability.
- **Enrichment happens once.** Sync-time HubSpot/Stripe enrichment
  (contacts, activity, `interval_count`) is expensive and belongs in a
  batch job, not a request.
- **Determinism.** Every isolate serves the same committed data;
  debugging "what did the page show" is reproducible from the commit.

## Consequences

- Data is **up to ~12h stale**. Acceptable for CS workflows; a "Run
  workflow" button forces an immediate refresh when needed.
- The snapshot must survive the **month-rollover Profitwell lag** — hence
  the ARR $0 guard (`scripts/sync.ts:354`) that refuses to overwrite a
  good snapshot with an all-zero pull. ([ADR context](../architecture.md#sync-the-refresh-job))
- Adding a field means it must round-trip the mapper
  ([how-to](../how-to/adding-a-metabase-field.md)).
