# Architecture

A deeper map of how CSM Mission Control is put together. Start with
[`CLAUDE.md`](../CLAUDE.md) for the quick mental model; come here when you
need the detail behind a specific subsystem.

## The big picture

It's a **Next.js 16 App Router** app (React 19, Tailwind v4) deployed on
Vercel. There is no separate backend — "the backend" is:

- **Server components + `src/app/api/**/route.ts` handlers** that call
- **engines** (`src/lib/engines/`) and **data loaders** (`src/lib/data/`), which read from
- two data sources: a committed **encrypted snapshot** of the book of
  business (the default), and a **KV store** (Postgres in prod, JSON
  files in dev) for everything mutable (settings, overrides, templates,
  review states, per-CSM state, Gmail tokens…).

```
Browser
  │
  ▼
Next.js (Vercel, region iad1)
  ├── Server components / API routes  (src/app)
  │      │
  │      ├── engines        (src/lib/engines)     ← pure-ish: Customer[] → report
  │      ├── data loaders   (src/lib/data)        ← loadCustomers(), settings, overrides…
  │      └── integrations   (src/lib/integrations)← gmail, slack, hubspot
  │
  ├── Book of business  →  data/snapshot.enc.json   (AES-256-GCM, committed)
  │                         refreshed twice daily by a GitHub Action
  └── Mutable state     →  KV: csm_kv table (prod) | data/*.json (dev)
```

## The data lifecycle

This is the flow every customer row travels. Memorize it — most features
touch some point on this line.

```
Metabase q10600 row  (raw Record<string, unknown>)
   │   snapshot: decrypt data/snapshot.enc.json   OR   live: runSavedQuestion(10600)
   ▼
metabaseRowToCustomer(row)          src/lib/data/metabase-mapper.ts   ← THE mapping choke point
   ▼
dedupeByWorkspace(rows)             src/lib/data/load-customers.ts:42  ← collapse join-multiplied dupes
   ▼
[ cached 60s per isolate ]          load-customers.ts:30              ← RAW rows only
   ▼
applyOverride(c, overrides)         customer-overrides.ts:157         ← CSM-authored KV bag
   ▼
mergeOverlayInto(…, hubspot)        hubspot-overlay.ts:82             ← "Resync from HubSpot" output
   ▼
mergeCadenceInto(…, cadence)        send-cadence.ts:198               ← daily ClickHouse inference
   ▼
[ ...withCadence, TEST_CUSTOMER ]   load-customers.ts:148
   ▼
Customer[]  →  server component  →  your UI
```

Key facts:

- **`loadCustomers()`** (`load-customers.ts:119`) is the one entry point
  every page and engine uses.
- **The cache holds only raw rows** (60s TTL, per serverless isolate).
  The three KV-backed layers (`applyOverride` → `mergeOverlayInto` →
  `mergeCadenceInto`) are **re-applied on every call** so a write on one
  isolate is visible immediately everywhere. Don't move the layers
  inside the cache.
- **`DATA_SOURCE`** env (`getDataSource()`, `:12`) picks `snapshot`
  (default, and what CI/prod use) vs `metabase` (live per-page read).
  Anything unset → snapshot.
- **`metabaseRowToCustomer`** is used by *both* the snapshot and live
  paths, so a field added there works in both. Fields not listed there
  are silently dropped on the snapshot round-trip.
- **Layer responsibilities are disjoint and ordered** — see the table in
  [ADR-0004 context](adr/0004-no-cache-on-mutable-stores.md) and the
  per-layer notes below.

### Why dedupe exists

q10600's underlying join multiplies rows for ~4 workspaces. Without
`dedupeByWorkspace`, the renewals tab shows duplicates, aggregate ARR
overcounts by tens of thousands, and bulk email double-sends.
`enrichmentScore` (`load-customers.ts:42`) keeps the most-enriched copy
of each `workspace_id`. Rows with no `workspace_id` pass through
untouched. **Gotcha:** the pick relies on exactly one copy being
enriched at sync time — if HubSpot enrichment soft-fails during sync,
the dedupe pick becomes arbitrary.

### The override / overlay layers

| Layer | File | KV key | May change | Must NOT touch |
|---|---|---|---|---|
| `applyOverride` | `customer-overrides.ts:157` | `customer-overrides` | `interval`, `hubspot_company_id`, `expected_send_cadence_days`, generic `field_overrides` (e.g. `property_risk_level`) | `customer_success_manager`/`_email` (hardcoded back to snapshot — CSM is single-sourced from q10600) |
| `mergeOverlayInto` | `hubspot-overlay.ts:82` | `csm:hubspot-overlay:v1` | `hubspot_contacts`, `last_activity_at/_source`, `property_customer_folder` (fill-only, never nulls) | ARR/MRR/subs, risk/status |
| `mergeCadenceInto` | `send-cadence.ts:198` | `csm:send-cadence:v1` | `inferred_cadence_days` + timestamps only | everything else |

## Sync: the refresh job

`scripts/sync.ts` (run by `.github/workflows/sync-data.yml`, cron
`0 8,16 * * *` — twice daily including weekends) is what keeps the
snapshot fresh:

1. Pull Metabase **q10600** (book) + **q23101** (multi-month renewal
   cadence → `interval_count`) + cohort questions (q13268 approaching-ent,
   q24620 past-due) + ClickHouse deliverability.
2. **HubSpot enrichment** (gated on a token; soft-fails and continues
   un-enriched): resolve companies by Stripe id (canonical join key),
   stamp `hubspot_company_id`, activity rollup, contacts.
3. **ARR $0 guard** (`:354`): if incoming rows sum to $0 ARR but the
   previous snapshot was non-zero (the month-rollover Profitwell lag),
   **`process.exit(1)` and refuse to overwrite** — keeps the live
   dashboard from flattening to $0. Override with `SYNC_ALLOW_ZERO_ARR=1`.
4. **Encrypt** (AES-256-GCM) → `data/snapshot.enc.json`, commit to
   `main`. Vercel auto-redeploys. (`SYNC_PLAINTEXT=1` writes the
   gitignored `data/snapshot.json` for debugging.)

See [ADR-0001](adr/0001-snapshot-not-live-query.md) for *why* it's a
snapshot and [ADR-0002](adr/0002-encrypted-snapshot-in-repo.md) for
*why* it's encrypted-in-git.

## Persistence: the KV store

Everything mutable goes through **`src/lib/storage/kv.ts`** — a single
`kvGet`/`kvSet`/`kvDelete` API over one of two backends, chosen by
whether `DATABASE_URL` is set:

- **Prod:** Postgres, one table `csm_kv (key TEXT PK, value JSONB, updated_at)`.
- **Dev:** JSON files under `data/<key>.json`.

File-vs-DB is a **deploy-time decision, never a code change**. Keys use
`csm:<feature>:v1` for new features (bump `:v1`→`:v2` to abandon a
shape); a few legacy bare keys remain (`settings`, `gmail-tokens`,
`customer-overrides`, `flag-resolutions`). `kvSet`/`kvDelete` **no-op in
`DEMO_MODE`**. See [ADR-0003](adr/0003-kv-storage-abstraction.md).

**The recurring store shape** (settings, flags, review-states, per-CSM
state all follow it):

- A client-safe **`*-types.ts`** (pure types + constants, no Node
  imports) so components can import the shape, and a server-only
  **`*.ts`** store that imports `kv.ts`.
- **Migration-on-read:** the loader deep-merges the stored partial over
  a `DEFAULTS` constant, so newly-shipped fields self-heal on deploy.
- Many stores **deliberately have no module cache** —
  [ADR-0004](adr/0004-no-cache-on-mutable-stores.md).

## Engines and the API/CLI/cron triad

Engines (`src/lib/engines/`) are the analytical core: **input =
`Customer[]` + options → output = a plain report object**, with no
request-lifecycle coupling. That's the key design payoff — the same
`runAtRiskCheck()` runs from:

- an **API route** (`/api/at-risk`) for the dashboard,
- a **CLI** (`npm run run:at-risk`) via a thin `scripts/` wrapper,
- a **cron sweep** (a GitHub Action hitting a route with `CRON_SECRET`).

See [ADR-0005](adr/0005-engines-as-pure-functions.md) and the engine
inventory in [`CLAUDE.md`](../CLAUDE.md#engines-and-headless-runs).

## Auth (two independent systems)

1. **Sign-in** — NextAuth v5, Google, gated to `@beehiiv.com`
   (`src/auth.ts`). Scope is minimal (`openid email profile`).
2. **Per-CSM Gmail** — a *separate* OAuth flow (`/api/auth/google/*`)
   for the heavy `gmail.compose` scopes, opted into at `/settings/gmail`.
   The active mailbox is tracked by an HttpOnly `csm_active_email`
   cookie, **not** the NextAuth session.

See [ADR-0006](adr/0006-two-tier-gmail-oauth.md). **Gotcha:** the
`auth.ts` docstring mentions middleware forcing a session — there is no
`middleware.ts`; enforcement is per-page. Unauthenticated viewers
resolve to an empty book, `/admin/*` redirects non-admins.

## Where things live

```
src/
├── app/
│   ├── page.tsx              Mission Control overview
│   ├── csm/ am/ ad-gap/      the dashboards
│   ├── account/[id]/         per-customer drill-in
│   ├── settings/             general / templates / tiers / slack / gmail / …
│   └── api/**/route.ts       ~130 JSON endpoints (engines + KV stores)
├── components/               ~74 flat kebab-case .tsx + am/ home/ filters/ subfolders
└── lib/
    ├── data/                 loaders, settings, overrides, flags, per-CSM state (+ *-types.ts)
    ├── engines/              at-risk, deliverability, ad-gap, wins, renewal-milestones, …
    ├── templates/            template store, merge-tags, bulk-drafts
    ├── integrations/         gmail-api, slack, hubspot
    ├── storage/kv.ts         the persistence primitive
    ├── auth/                 admin, csm-team, feature-flags
    ├── demo/                 DEMO_MODE fixtures
    ├── metabase.ts           runSavedQuestion / runNativeQuery
    └── types.ts              the central Customer type + shared domain types
```
