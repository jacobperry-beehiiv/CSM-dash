# Demo mode

Local-only mode that swaps every data source for a hand-built fixture so the dashboard can be screenshotted without touching real customer data.

## Enable

In `.env.local`:

```
DEMO_MODE=true
```

Then `npm run dev`. The flag is server-only — never bundled to the client.

## What's swapped

| Loader | Real source | Fixture |
| --- | --- | --- |
| `loadCustomers()` | Metabase q10600 / snapshot | `buildDemoCustomers()` — 15 fictional publications |
| `loadApproachingEnterprise()` | Metabase q13268 | `buildDemoApproachingEnt()` — 5 rows |
| `loadPastDue()` | Metabase q24620 | `buildDemoPastDue()` — 3 rows |
| `/api/qbr-charts/chart-spec` | Metabase + heuristic | `buildDemoChartSpec()` — canned spec per preset |
| `resolveCsmFilter()` | viewer email → CSM handle | defaults to "show all" |

## Write paths

Defense in depth — every write helper short-circuits in demo mode:

- `kvSet()` / `kvDelete()` — no-op (no overrides, no review state, no flag resolutions persist between reloads)
- `slackPost()` — logs and returns; never hits the Slack API
- `patchHubspotCompanyProperties()` — logs and returns

If a UI action fires a write endpoint, the route still returns success but nothing leaves the box.

## Not swapped

- **Deliverability tab** — live engine, not currently fixtured. Avoid that tab in screenshots, or open it knowing it'll fail to load.
- **Auth / Gmail OAuth** — per-user. You still sign in normally to use the dashboard.

## Adding fixtures

The fixture files are all in this directory:
- `customer-fixture.ts` — the book
- `am-fixtures.ts` — Past Due, Approaching Enterprise
- `qbr-fixtures.ts` — chart specs per preset

Each file's exports are pure functions returning real types — change a number, edit a name, the next page load reflects it.
