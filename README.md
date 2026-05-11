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

## Deploying

Two external accounts are required: **GitHub** (where the code lives) and
**Vercel** (where it runs). Postgres is provisioned from inside Vercel as
part of step 3 — no Neon dashboard, no separate signup.

### 1. Push to GitHub

```bash
gh repo create beehiiv/csm-dash --private --source=. --remote=origin --push
```

Or do it through the web: create an empty private repo, then `git remote add origin … && git push -u origin main`.

### 2. Import the repo into Vercel

[vercel.com/new](https://vercel.com/new) → "Import Git Repository" → pick
the repo. Framework auto-detects as Next.js. Don't click "Deploy" yet —
add the env vars first.

### 3. Add a Vercel Postgres database

In the Vercel project settings → **Storage** tab → **Create Database** →
**Postgres**. One click; Vercel auto-injects `DATABASE_URL` into the
project's environment. The `csm_kv` table auto-creates on first write.

### 4. Add the remaining env vars

In the project settings → **Environment Variables**, paste these (copy
values from your local `.env.local`):

```
DATA_SOURCE=metabase
METABASE_URL=https://beehiiv.metabaseapp.com
METABASE_API_KEY=<your key>
AUTH_SECRET=<run: openssl rand -base64 33>
GOOGLE_CLIENT_ID=<your Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<your Google OAuth client secret>
NEXT_PUBLIC_MASQUERADE_URL_TEMPLATE=https://app.beehiiv.com/system_admin/users/masquerade?email={email}
NEXT_PUBLIC_METABASE_PUB_URL_TEMPLATE=https://beehiiv.metabaseapp.com/question/3401-all-with-filters?company_%252F_workspace_search={workspace_name}
```

`DATABASE_URL` is already populated by step 3. The Google client ID/secret
is shared between Gmail draft creation and NextAuth sign-in.

### 5. Deploy

Click **Deploy**. First build takes ~90s. You'll get a
`https://<project>.vercel.app` URL.

### 6. Register the Vercel URL with Google

In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials),
open your OAuth 2.0 Client and add both redirect URIs under
**Authorized redirect URIs**:

```
https://<your-vercel-domain>/api/auth/callback/google     ← NextAuth sign-in
https://<your-vercel-domain>/api/auth/google/callback     ← per-CSM Gmail
```

That's it. Open the Vercel URL → sign in with Google (`@beehiiv.com` only)
→ optionally connect Gmail at `/settings/gmail` → start drafting.

### How customer data lives

The book of business is committed to the repo as an AES-256-GCM-encrypted
file at `data/snapshot.enc.json`. The runtime decrypts on read using a
symmetric key from `SNAPSHOT_ENCRYPTION_KEY`. The plaintext snapshot
(`data/snapshot.json`) stays gitignored — only the encrypted envelope is
ever pushed.

**Refresh paths**:

- **Scheduled** — `.github/workflows/sync-data.yml` runs twice every
  weekday (08:00 + 16:00 UTC), pulls Metabase q10600, encrypts, commits
  back to `main`. Vercel auto-redeploys on the new commit.
- **Manual** — same workflow, "Run workflow" button on the Actions tab.
  Useful for "I just changed a CSM assignment in HubSpot and want it
  reflected now."
- **Local** — `npm run sync` produces the encrypted file too, useful for
  smoke-testing the encrypt/decrypt round-trip. Pass `SYNC_PLAINTEXT=1`
  if you want the unencrypted JSON for debugging (it's gitignored).

**Required secrets**:

| Secret | Where |
|---|---|
| `METABASE_API_KEY` | GitHub Actions + Vercel + `.env.local` |
| `SNAPSHOT_ENCRYPTION_KEY` (32-byte base64) | GitHub Actions + Vercel + `.env.local` — same value all three places |

Generate the encryption key once with:
```bash
openssl rand -base64 32
```
**Don't rotate it casually** — old commits in the repo will become
undecryptable. If you do rotate, run a fresh sync immediately so the new
key has a valid file to decrypt.

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
