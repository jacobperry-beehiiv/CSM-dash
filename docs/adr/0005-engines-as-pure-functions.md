# ADR-0005: Engines are options-in / report-out functions

**Status:** Accepted · **Baked into:** `src/lib/engines/*`, `scripts/run-*.ts`,
the cron workflows

## Context

The analytical work — at-risk scoring, deliverability alerts, ad-gap,
wins detection, renewal milestones — needs to run in three contexts: a
dashboard API route, a headless CLI (for ops/debugging), and a scheduled
cron sweep (posting Slack pings).

## Decision

Write each engine as a function that takes **options (including an
optional pre-loaded `Customer[]`) and returns a plain report object**,
with no coupling to the request lifecycle. Side effects (Slack, HubSpot
writes) are injected or confined to the sweep wrappers, and pure
sub-rules (`flagA`…`flagH`, `priorityScore`, `wins-rules`) are exported
separately.

```ts
runAtRiskCheck({ csmName?, customers?, signals?, exclude?, now? })
  : Promise<AtRiskRunResult>
```

## Why

- **One implementation, three callers.** `/api/at-risk`,
  `npm run run:at-risk`, and the cron sweep all call the exact same
  function with no adaptation. No logic drift between "what the dashboard
  shows" and "what the sweep pings about."
- **Testable core.** The pure rule helpers have no I/O, so they can be
  checked directly (the migration-warmup engine even has unit tests that
  mirror a Python reference byte-for-byte).
- **Injectable I/O.** At-risk's signal flags (D/E/F) are an injected
  `SignalSource` of async callbacks; default callers pass none, so the
  engine degrades gracefully without Gmail/web-search wired in.

## Consequences

- Engines default to `await loadCustomers()` but accept an injected book
  — pass one to avoid a redundant load when you already have it.
- Headless runs print a **human summary to stderr** and **JSON to
  stdout**, so `npm run run:at-risk | jq` works.
- New analysis should be an engine (in `src/lib/engines/`), not inline
  route logic — keep routes thin.
