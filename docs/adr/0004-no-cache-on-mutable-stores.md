# ADR-0004: Mutable stores deliberately have no module cache

**Status:** Accepted · **Baked into:** `settings.ts`,
`customer-overrides.ts`, `flag-resolutions.ts`, the per-CSM state blobs

## Context

Reading KV on every request is a round-trip. The obvious optimization is
a module-level cache. But Vercel runs many warm serverless **isolates**,
each with its own module memory.

## Decision

The frequently-**written** stores (settings, customer overrides, flag
resolutions, per-CSM state) **do not cache** — every read pays the KV
round-trip. Only rarely-changing, read-mostly data caches, and always
with a short TTL and/or an explicit invalidation hook.

## Why

A module cache on a mutable store causes **stale reads across isolates**:
isolate A writes an override; isolate B still serves its cached copy
until its TTL expires. Symptoms seen in this codebase before the caches
were removed:

- Cadence toggles appeared to "revert" (a different isolate served the
  pre-write value).
- A settings field saved from the UI but the webhook always read the
  default (frozen pre-migration shape).

The customer *raw rows* cache (60s) is fine because that data only
changes on deploy (new snapshot); the **KV override layers on top are
re-applied uncached on every `loadCustomers()`** precisely so writes
propagate immediately ([architecture](../architecture.md#the-data-lifecycle)).

## Consequences

- **Before adding a cache to any `data/` store, read its header comment.**
  Several explicitly document why they don't cache. Don't "optimize" them.
- Where caching is genuinely worth it, pair it with invalidation:
  `feature-flags.ts` caches 60s **and** exposes
  `invalidateFeatureFlagsCache()`, called from the flags PUT.
- The real fix for read cost isn't a per-isolate cache; it's keeping the
  blobs small and the reads cheap.

## Related

The same "warm-isolate staleness" reasoning drove the `/api/settings/field-mappings`
fan-out fix: the client dedupes into one shared fetch, and the server
memo is short-TTL + PUT-invalidated rather than indefinite.
