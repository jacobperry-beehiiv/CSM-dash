# How to: surface a new Metabase field in the dashboard

You want a column that already exists (or that you're adding) in the
Metabase **book-of-business** question (`q10600`) to show up on the
`Customer` object and render somewhere in the UI.

This is the single most common change in the codebase. The worked
example below is exactly [PR #146](https://github.com/jacobperry-beehiiv/CSM-dash/pull/146),
which added `contract_renewal` to the Renewals table.

## Mental model (read this first)

Every customer row travels this path
([details](../architecture.md#the-data-lifecycle)):

```
Metabase q10600 row  (raw Record<string, unknown>)
   │   ── snapshot: data/snapshot.enc.json  OR  live: runSavedQuestion(10600)
   ▼
metabaseRowToCustomer(row)     ← src/lib/data/metabase-mapper.ts  (the choke point)
   ▼
Customer                       ← src/lib/types.ts  (the typed shape the UI reads)
   ▼
your component                 ← reads c.your_field
```

`metabaseRowToCustomer` is a **single choke point used by both the
live-Metabase path and the snapshot path**, so you only wire the field
in one place and it works everywhere.

## Steps

### 1. Add the field to the `Customer` type

`src/lib/types.ts` — add it near related fields, with a doc comment
explaining where it comes from and how it differs from neighbours.

```ts
/**
 * Contractual renewal date straight from q10600's `contract_renewal`
 * column. Distinct from `renewal_date` / `next_invoice`, which can fall
 * back to the Stripe next-invoice date. Null for month-to-month accounts.
 */
contract_renewal?: string | null;
```

Optional (`?:`) vs required matters: if you make it **required**, every
inline `Customer` literal must set it — the fixtures in
`src/lib/data/synthesize-customer.ts`, `src/lib/data/test-customer.ts`,
and `src/lib/demo/customer-fixture.ts`. Prefer **optional** unless you
have a reason not to; the mapper always sets a value anyway.

### 2. Map the raw column onto the field

`src/lib/data/metabase-mapper.ts`, inside `metabaseRowToCustomer`. Match
the surrounding idiom:

| Field kind | Pattern |
|---|---|
| Plain value | `contract_renewal: (row.contract_renewal as string \| null) ?? null,` |
| String that HubSpot may return as `false`/number | `foo: asStringCell(row.foo),` |
| Numeric | `bar: Number(row.bar) \|\| 0,` (or `?? null`) |
| Multi-source fallback | `x: (row.a as string \| null) ?? (row.b as string \| null) ?? null,` |

> **Why `asStringCell`?** HubSpot returns `false` for an unset text
> property; without coercion the UI renders the literal string "false".
> See `metabase-mapper.ts` top-of-file comment.

> **Gotcha:** any field you *don't* list here is **silently dropped** on
> the snapshot round-trip. If your field is written by the sync
> enrichment (step 4), it still won't appear unless it's mapped here.

### 3. Render it

Read `c.your_field` in the component. Format dates/currency with the
helpers in `src/components/format.ts` (`fmtDate`, `fmtCurrency`,
`fmtNumber`) so `null` renders as `—` consistently.

For a **table column** (e.g. `renewal-panel.tsx`) remember to update all
of: the `<colgroup>` width, the `<th>` header, the `<td>` cell, **and**
any `colSpan` on the expanded/detail row. Missing the `colSpan` bump is
the classic off-by-one that misaligns the expanded panel.

### 4. (Only if the column doesn't already exist in q10600)

If Metabase already returns the column, **you're done** — it's in the
raw snapshot rows already, so existing snapshots render it immediately
with no data refresh.

If the value is *derived at sync time* (HubSpot/Stripe enrichment rather
than a raw q10600 column), add it in `scripts/sync.ts` where the other
enrichment keys are written (`hubspot_*`, `last_activity_*`,
`interval_count`), then map it in step 2. See
[the data lifecycle doc](../architecture.md#sync-the-refresh-job).

## Verify

There are no unit tests; the gates are the type-checker and the browser.

```bash
npx tsc --noEmit           # === npm run lint
```

Then run it locally and look ([local dev](../../CLAUDE.md#local-development)):

```bash
VERCEL_ENV=preview PREVIEW_AUTH_TOKEN=dev npm run dev
```

Sign in via the preview form, navigate to the surface, confirm the field
renders (and shows `—` when null rather than "false"/blank).

> **Demo-mode note:** local dev usually runs with `DEMO_MODE=1`, whose
> synthetic fixtures won't populate your new field — so it will read `—`
> locally even when prod data has values. That's expected; verify the
> *wiring* locally and the *values* against a real snapshot.

## Checklist

- [ ] `Customer` type has the field (`src/lib/types.ts`)
- [ ] Mapped in `metabase-mapper.ts` (correct idiom for its kind)
- [ ] Rendered in the component (`fmt*` helper for null-safety)
- [ ] Table changes complete: colgroup + th + td + colSpan
- [ ] `tsc --noEmit` passes
- [ ] (If sync-derived) written in `scripts/sync.ts`
- [ ] Verified in-browser
