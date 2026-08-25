# How to: add a settings field (and feature flags)

Tunables the CSM/AM team edits at `/settings/*` — thresholds, Slack
channels, lifecycle stages, flag re-raise periods — live in one KV row
behind a **client-safe types module + a server store**. This is the same
shape used by almost every KV-backed feature, so it's worth learning
once.

## The store shape (used everywhere)

Every KV-backed feature splits into two files:

- **`src/lib/data/<feature>-types.ts`** — pure types + `DEFAULTS`
  constant, **no `kv`/Node imports**, so client components can import the
  shape.
- **`src/lib/data/<feature>.ts`** — the server store; imports
  `src/lib/storage/kv.ts`.

Reads **migrate-on-read**: the loader deep-merges the stored partial over
`DEFAULTS`, so a newly-shipped field self-heals on existing installs.

## Adding a settings field

Settings live under KV key `"settings"`; types in `settings-types.ts`,
store in `settings.ts`, route at `/api/settings/route.ts`.

### 1. Add the field + default

`src/lib/data/settings-types.ts` — add it to `SettingsShape` (or a
sub-interface) and give it a value in `DEFAULTS`.

```ts
export interface SettingsShape {
  flags: …;
  thresholds: …;
  slack: …;
  my_section?: { my_field: number };   // new
}

export const DEFAULTS: SettingsShape = {
  …,
  my_section: { my_field: 30 },         // new
};
```

### 2. ⚠️ Wire it into `merge()` — the trap that will get you

`src/lib/data/settings.ts`, the `merge()` function (~`:99`). **Any
top-level field not explicitly spread here is silently dropped on every
`loadSettings()`.** This is a real bug that shipped (`personal_todos`
saved fine from the UI but the webhook always read the default because
`merge()` didn't carry it).

```ts
function merge(stored: Partial<SettingsShape>): SettingsShape {
  return {
    flags: { ...DEFAULTS.flags, ...stored.flags },
    thresholds: { ...DEFAULTS.thresholds, ...stored.thresholds },
    my_section: { ...DEFAULTS.my_section, ...stored.my_section },  // ADD THIS
    …
  };
}
```

If your field belongs under an existing section that's already merged
deeply, you may be covered — but verify. When in doubt, add the explicit
spread.

### 3. Add the UI

A control on the relevant `/settings/*` page that GETs `/api/settings`,
edits, and PUTs it back. Follow a neighbouring field's pattern.

> **Route auth gotcha:** `/api/settings` PUT has **no auth check of its
> own** — it relies on the app being behind sign-in. Treat settings
> writes as unauthenticated at the route boundary; don't put anything
> there that needs per-user authorization.

### Read-time migration idiom

If you're *renaming/restructuring* a field (not just adding one), follow
the `migrateSlack`/`migrateAm` pattern in `settings.ts` (and
`resolveSlackNotificationPref` in `settings-types.ts`): keep reading the
old shape and fold it into the new one at load time, so old stored rows
keep working.

## Feature flags

Flags (ship-dark gates) are a parallel system:
`admin-flags-types.ts` + `admin-flags.ts` + `feature-flags.ts`, KV key
`csm:admin-flags:v1`, admin UI at `/admin/flags`.

Each flag is a `FeatureGate { restricted: boolean; allowed_emails: string[] }`:

- `restricted: false` → everyone eligible passes.
- `restricted: true` + email in `allowed_emails` → passes.
- `restricted: true` + **empty** list → kill switch (nobody).

**To add a flag:**

1. Add the id to the `FeatureId` union (`admin-flags-types.ts:14`).
2. Add a `DEFAULT_FLAGS.features` entry — **required**, or existing
   installs go dark for it. Ship-dark convention is
   `{ restricted: true, allowed_emails: ["jacob.perry@beehiiv.com"] }`.
3. Add a `FEATURE_METADATA` entry so it renders on `/admin/flags`.
4. Gate the feature: `if (!(await isFeatureEnabledFor("my-flag", email)))`
   at the API route (and pair with the feature's own eligibility check —
   the flag only *narrows*).

`isFeatureEnabledFor` has a **60s cache** (per isolate); the flags PUT
calls `invalidateFeatureFlagsCache()` so admin saves propagate
immediately. It **soft-fails to `false`** on any KV error.

## The per-CSM state variant

If you're storing per-CSM (or per-workspace) working state rather than
global settings, use the **per-CSM state blob** pattern — one KV row
holding all users' slices, keyed by normalized email inside the blob.
Canonical example: `src/lib/data/sybill-ingest-state.ts`
(`{ per_csm: Record<email, State>, fetched_at }` with
`load → getCsmState → mutate-in-place → save`). For per-workspace state
with bulk edits, mirror `review-states.ts` and provide a **batch**
mutator (`setReviewStatesBatch`) that collapses N updates into one
read-modify-write.

> **Gotcha:** these blobs are read-modify-write with **no locking** — two
> concurrent writers to the same key can clobber each other. Keep blobs
> small and writes infrequent; batch bulk operations.

## Verify

```bash
npx tsc --noEmit
```

Then, on the settings page: change the value, reload, confirm it
**persisted** (this is exactly what catches a missing `merge()` wire-up —
the value reverts to default on reload if you forgot step 2). Note that
in `DEMO_MODE` writes no-op, so test persistence with demo mode **off**.
