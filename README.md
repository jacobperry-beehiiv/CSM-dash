# CSM Mission Control

A consolidated, self-contained operational dashboard for the beehiiv Customer
Success team. One view for product utilization, deliverability, at-risk
accounts, and renewals — with both a CSM-side (Enterprise) lens and an AM-side
(Growth) lens, filterable across the whole team.

## What's inside

| Surface | What it shows |
|---|---|
| **Mission Control** (`/`) | Portfolio tiles: at-risk, renewals soon, dormant, sub-cap pressure, approaching-ent. |
| **CSM Dashboard** (`/csm`) | Enterprise + Growth book across four tabs (All assigned / Deliverability / At-risk / Renewals). Feature-utilization and ad-network filters drill in. |
| **AM Dashboard** (`/am`) | Three tabs: Enterprise Only, Approaching Enterprise (≥75% to 100K subs), Past Due. |
| **Ad Gap** (`/ad-gap`) | Per-organization fill-rate vs. potential, with cascade fallback for new customers. |
| **Templates** (`/settings/templates`) | Browsable / editable outreach library with rich-text editor and merge tags. |
| **Settings** (`/settings`) | Flag re-raise periods, thresholds, Slack channels, Gmail OAuth, Enterprise tier ladder. |
| **Account drill-in** (`/account/:id`) | Per-customer view: status, goals, dates, monetization, T4 onboarding. |

The team-wide CSM filter and Enterprise/Growth/All segment toggle live in the
header and apply across every page via URL search params.

## Local setup

```bash
cp .env.example .env.local
# In .env.local, paste your METABASE_API_KEY and set DATA_SOURCE=metabase
# (or stay on snapshot and run `npm run sync` once to populate data/snapshot.json).
npm install
npm run dev
```

Open <http://localhost:3000>.

## Deploying to Vercel + Neon

The dashboard is fully serverless-ready. Persistent state (Gmail tokens,
settings, templates, tier ladder, flag resolutions, customer overrides) is
written to a single `csm_kv` Postgres table when `DATABASE_URL` is set;
without it, those land in JSON files under `data/` (fine locally, broken on
Vercel).

1. **Push to GitHub.** Standard `git init && git remote add origin … && git push -u origin main`.
2. **Provision Postgres.** Free option: [Neon](https://neon.tech). Create a
   project, copy the pooled connection string. Vercel Postgres / Supabase
   work identically.
3. **Import to Vercel.** New Project → pick the GitHub repo → Framework
   detected as Next.js. Add the env vars from `.env.example`:
   - `DATABASE_URL` — Neon connection string
   - `METABASE_URL`, `METABASE_API_KEY`
   - `DATA_SOURCE=metabase` (snapshot mode needs a writable filesystem)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - the two `NEXT_PUBLIC_*` link templates
4. **Deploy.** First deploy auto-creates the `csm_kv` table on first write.
5. **Wire OAuth callback.** In Google Cloud Console → Credentials → your OAuth
   client, add `https://<your-vercel-domain>/api/auth/google/callback` to
   Authorized redirect URIs. Each CSM then connects their own Gmail at
   `/settings/gmail`.

The Mission Control page is the entry point — link to it from your existing
internal portal (auth happens there; the dashboard itself does not gate access).

## Architecture

```
src/
├── app/
│   ├── page.tsx                  Mission Control overview
│   ├── csm/page.tsx              CSM tabs (book / deliv / at-risk / renewals)
│   ├── am/page.tsx               AM dashboard (3 tabs)
│   ├── account/[id]/page.tsx     Per-customer drill-in
│   ├── settings/                 General / Templates / Tiers / Slack / Gmail
│   ├── ad-gap/page.tsx           Portfolio fill-rate view
│   └── api/                      Engines exposed as JSON endpoints
├── components/                   UI primitives
└── lib/
    ├── data/                     loaders, settings, overrides, flag-resolutions
    ├── engines/                  at-risk, deliverability, ad-gap, am-cohorts, …
    ├── storage/kv.ts             KV (Postgres in prod, JSON files in dev)
    ├── templates/                template store + merge tags
    ├── tiers/                    Enterprise tier ladder
    ├── integrations/             gmail-api, slack
    └── metabase.ts               Auth abstraction + runNativeQuery
```

### At-risk flags

| Code | Source | Trigger |
|---|---|---|
| **A** | book of business | `last_send` null or >10 days ago |
| **B** | book of business | `last_log_in` null (q10600 only populates this when <14d) |
| **C** | book of business | `percent_of_max_subs < 0.75` |
| **G** | book of business | CSM-flagged Yellow or Red in HubSpot (`property_risk_level_csm_`) |
| **H** | book of business | `last_contacted` >45 days ago |
| **D** | signal source | Frustration signal (Gmail integration) |
| **E** | signal source | No contact in 90+ days (Gmail) |
| **F** | signal source | Notable news on contact/company (web search) |

Resolved flags are filtered out until they age past the per-flag re-raise
period configured at `/settings`.

## CLI

```bash
# refresh data/snapshot.json from Metabase
npm run sync

# yesterday's deliverability check
npm run run:deliverability

# weekly at-risk
npm run run:at-risk
```
