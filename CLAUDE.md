# CLAUDE.md — working on CSM Mission Control

Orientation for engineers (and AI agents) working in this repo. It's the
"how to change the code" companion to [`README.md`](README.md) (which
covers what the product is + how to deploy it). Deeper maps live in
[`docs/`](docs/).

> **New here?** Read [The mental model](#the-mental-model) →
> [Local development](#local-development) → the relevant
> [how-to](docs/how-to/). Then skim [Gotchas](#gotchas-that-will-bite-you).

## What this is

A single Next.js app that gives the beehiiv Customer Success team one
operational view of their book of business — utilization, deliverability,
at-risk accounts, renewals, and outreach drafting — across a CSM
(Enterprise) and AM (Growth) lens. Deployed on Vercel.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript (strict) ·
Tailwind v4 (no config file; PostCSS) · NextAuth v5 · `postgres` driver
(no ORM) · Recharts. Package manager is **npm** (`package-lock.json`).

## The mental model

Two things to internalize; everything else follows.

**1. Customers flow through one pipeline.** Every page reads
`Customer[]` from `loadCustomers()`, which turns raw Metabase rows into
typed `Customer`s through a fixed sequence: map → dedupe → cache(raw,
60s) → apply KV override/overlay/cadence layers → render. The mapping
happens at **one choke point**, `src/lib/data/metabase-mapper.ts`. Full
diagram: [docs/architecture.md#the-data-lifecycle](docs/architecture.md#the-data-lifecycle).

**2. Two data worlds.** *Read-mostly* book-of-business data comes from a
committed, **encrypted snapshot** (`data/snapshot.enc.json`), refreshed
twice daily by a GitHub Action. *Everything mutable* (settings,
overrides, templates, review states, per-CSM state, Gmail tokens) lives
in a **KV store** — Postgres in prod, JSON files in dev — behind
`src/lib/storage/kv.ts`.

```
loadCustomers()  ─► snapshot (default)  or  live Metabase q10600
                 ─► metabase-mapper ─► dedupe ─► cache ─► overrides/overlay/cadence
kvGet/kvSet      ─► Postgres (prod)  |  data/*.json (dev)
engines          ─► Customer[] + opts ─► report  (run from route | CLI | cron)
```

## Local development

No tests to run; the gates are the type-checker and your eyes in the
browser.

```bash
cp .env.example .env.local          # fill METABASE_API_KEY + SNAPSHOT_ENCRYPTION_KEY
npm install
npm run dev                         # Next dev on http://localhost:3000
```

**Signing in locally.** Google OAuth won't issue against localhost the
way it does in prod, so use the **preview-auth bypass**: run with
`VERCEL_ENV=preview` and a `PREVIEW_AUTH_TOKEN`, then enter that token in
the "Preview sign-in" box on `/login` (stubs a session as
`PREVIEW_AUTH_EMAIL`, default `jacob.perry@beehiiv.com`):

```bash
VERCEL_ENV=preview PREVIEW_AUTH_TOKEN=dev npm run dev
```

**`DEMO_MODE`.** Set `DEMO_MODE=1` to swap every data loader for
fictional fixtures and no-op all writes — useful for screenshots/UI work
without real data. Three surprises: (a) writes silently succeed at the
route but never persist; (b) the **Deliverability tab is not fixtured**
and will fail to load; (c) auth/Gmail OAuth are still live. See
[`src/lib/demo/README.md`](src/lib/demo/README.md).

**Verifying a change.** There are no unit tests wired into CI. The loop is:

```bash
npx tsc --noEmit          # === npm run lint === npm run typecheck; the ONLY static gate
```

then run the app and look. For anything visual, drive the local server
in the browser rather than asking someone to check. CI runs exactly
`npm run lint` (tsc) + `npm run build` — nothing else.

## Engines and headless runs

Engines (`src/lib/engines/`) take `Customer[]` + options and return a
plain report object, so the same function backs a dashboard route, a CLI,
and a cron sweep. Run them headless:

```bash
npm run sync                         # refresh the snapshot from Metabase
npm run run:at-risk -- --all         # at-risk engine, whole company (JSON on stdout)
CSM_NAME=Jacob_Perry npm run run:at-risk    # one CSM's book
npm run run:deliverability -- --date=2026-08-01
```

Inventory (one line each):

| Engine | Purpose |
|---|---|
| `at-risk.ts` | Flags A–H over a CSM book → scored `AtRiskAccount[]` |
| `deliverability.ts` | Enterprise deliverability alerts (ClickHouse) |
| `ad-gap.ts` / `ad-network-batch.ts` | Ad-network fill-rate & revenue-vs-potential |
| `am-cohorts.ts` | AM dashboard cohorts (4-layer cache → live Metabase) |
| `feature-utilization*.ts` | Per-org feature signals (send API, MCP, …) |
| `news-sweep.ts` | Daily Google News signals per workspace |
| `renewal-milestones.ts` | Renewal milestone sweep (90/60/30/7d) |
| `proactive-outreach.ts` · `review-digest.ts` · `wins*.ts` | Scheduled sweeps |
| `migration-warmup/` | Migration warm-up engine (has the only unit tests) |

## House style

Match what's there — the codebase is consistent and opinionated.

- **Comments are heavy and explain _why_.** Files open with multi-line
  header comments covering rationale, tradeoffs, and the bug that
  motivated the current shape. Section dividers use `// ─── Section ───`.
  A new engineer should over-explain intent and edge cases, not
  under-explain. This is the single most distinctive convention.
- **Naming split:** data/domain fields mirror their source columns in
  **snake_case** (`workspace_id`, `last_send`, `percent_of_max_subs`) —
  do **not** camelCase them. Functions, components, and locals are
  camelCase/PascalCase.
- **Server by default, `"use client"` to opt in.** Data loaders,
  `auth.ts`, and demo mode are server-only. Never import a server-only
  module into a client component — pass values as props. When you need a
  type on both sides, put it in a client-safe `*-types.ts` (no `kv`/Node
  imports) with the server logic in a sibling `*.ts`.
- **Types:** shared domain types in `src/lib/types.ts`; component props
  as a local `interface Props` in the same file; engine-local types in a
  sibling `types.ts`.
- **Imports** use the `@/` alias → `src/`.
- **Styling:** Tailwind v4 utility classes inline, with explicit
  `dark:` variants and semantic tokens (`text-fg`, `text-subtle`,
  `bg-surface`, `border-border`). Format numbers/dates/currency with
  `src/components/format.ts` so `null` renders `—`.
- **No ESLint, no Prettier** — formatting is by convention; `tsc` is the
  only automated check.

## API route conventions

Canonical skeleton and the full rules are in
[docs/how-to/adding-an-api-endpoint.md](docs/how-to/adding-an-api-endpoint.md).
The short version: `export const dynamic = "force-dynamic"`, `GET` is
usually an unauthed data read, mutations `await auth()` and 401 on no
email, wrap in try/catch returning `{ error }` + 500, and append an
`appendActionLog` audit entry after a mutation.

## Gotchas that will bite you

- **Mapper drops unlisted fields.** A field not added to
  `metabase-mapper.ts` is silently lost on the snapshot round-trip, even
  if `scripts/sync.ts` writes it.
- **Don't cache the mutable stores.** Several `data/` stores
  (`settings`, `customer-overrides`, `flag-resolutions`, per-CSM blobs)
  deliberately have **no module cache** because warm serverless isolates
  served stale writes. Read the header comment before adding one.
  ([ADR-0004](docs/adr/0004-no-cache-on-mutable-stores.md))
- **New top-level settings fields must be wired into `merge()`** in
  `settings.ts` or they're dropped on every read.
- **The ARR $0 sync guard** will `exit(1)` and refuse to overwrite the
  snapshot on the 1st of the month (Profitwell lag). That's intended.
- **CSM assignment is snapshot-only** — `applyOverride` intentionally
  ignores CSM overrides; don't "fix" it.
- **KV blobs are read-modify-write with no locking** — two concurrent
  writers to the same key can clobber each other. Keep per-CSM blobs
  small; use batch helpers (e.g. `setReviewStatesBatch`) for bulk ops.
- **No global auth middleware** despite the `auth.ts` docstring —
  enforcement is per-page.
- **Bulk drafts chunk at 40** to stay under Vercel's body limit; the
  Gmail `from` alias silently falls back to the primary on a 400 (the
  API route retries once without it).

## Documentation map

- [`README.md`](README.md) — product overview, local setup, **deploy**,
  data-refresh model, at-risk flag legend.
- [`docs/architecture.md`](docs/architecture.md) — the data lifecycle,
  override layers, sync job, KV store, engines, auth — in depth.
- [`docs/how-to/`](docs/how-to/) — task recipes:
  - [adding-a-metabase-field.md](docs/how-to/adding-a-metabase-field.md)
  - [adding-a-merge-tag.md](docs/how-to/adding-a-merge-tag.md)
  - [adding-an-at-risk-flag.md](docs/how-to/adding-an-at-risk-flag.md)
  - [adding-an-api-endpoint.md](docs/how-to/adding-an-api-endpoint.md)
  - [adding-a-settings-field.md](docs/how-to/adding-a-settings-field.md)
  - [adding-a-draft-cc-option.md](docs/how-to/adding-a-draft-cc-option.md)
- [`docs/adr/`](docs/adr/) — why the load-bearing decisions were made.
