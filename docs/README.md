# Engineering docs

Documentation for **working on** CSM Mission Control as an engineer. For
what the product is and how to deploy it, see the root
[`README.md`](../README.md).

## Start here

1. **[`CLAUDE.md`](../CLAUDE.md)** — the onboarding anchor. Mental model,
   local dev, house style, the gotchas that bite. Read this first.
   (Claude Code also auto-loads it.)
2. **[`architecture.md`](architecture.md)** — the data lifecycle,
   override layers, sync job, KV store, engines, and auth, in depth.

## How-to recipes

Task-oriented guides, each grounded in a real change:

- [Add a Metabase field](how-to/adding-a-metabase-field.md) — surface a
  q10600 column on the `Customer` object and in the UI.
- [Add a merge tag](how-to/adding-a-merge-tag.md) — a new
  `{{customer.x}}` token for templates.
- [Add an at-risk flag](how-to/adding-an-at-risk-flag.md) — a new rule in
  the at-risk engine.
- [Add an API endpoint](how-to/adding-an-api-endpoint.md) — the canonical
  route skeleton and conventions.
- [Add a settings field / feature flag](how-to/adding-a-settings-field.md)
  — the KV store + `merge()` pattern and the ship-dark flag system.
- [Add a per-draft field (CC/BCC)](how-to/adding-a-draft-cc-option.md) —
  threading a value through the UI → API → Gmail draft pipeline.

## Decision records (ADRs)

Why the load-bearing choices were made — read these before changing the
thing they describe:

- [0001 — Snapshot, not live query](adr/0001-snapshot-not-live-query.md)
- [0002 — Encrypted snapshot in the repo](adr/0002-encrypted-snapshot-in-repo.md)
- [0003 — One KV abstraction](adr/0003-kv-storage-abstraction.md)
- [0004 — No cache on mutable stores](adr/0004-no-cache-on-mutable-stores.md)
- [0005 — Engines as pure functions](adr/0005-engines-as-pure-functions.md)
- [0006 — Two-tier Gmail OAuth](adr/0006-two-tier-gmail-oauth.md)

## Keeping these current

These docs cite files by path and function name (with occasional line
anchors — treat those as approximate; line numbers drift). When you
change a subsystem, update its how-to and any relevant ADR in the same
PR. If a decision is reversed, add a new ADR that supersedes the old one
rather than editing history.
