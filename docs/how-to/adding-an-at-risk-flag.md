# How to: add an at-risk flag

The at-risk engine scores each account by raising **flags** A–H. Each
flag is a rule that fires on a `Customer` (or an external signal). This
guide adds a new flag end-to-end.

## Background

- Engine: `src/lib/engines/at-risk.ts`. `runAtRiskCheck(opts)` (`:304`)
  loads the CSM's book, evaluates flags per customer, filters out
  *resolved* flags, scores, and sorts.
- **Two classes of flag:**
  - **Book-of-business (A/B/C/G/H)** — pure functions of already-loaded
    `Customer` fields; computed synchronously in the loop.
  - **Signal source (D/E/F)** — need external I/O (Gmail, HubSpot, web
    search). The engine doesn't implement them; it accepts an injected
    `SignalSource` (`:221`) of optional `async (c) => RiskFlag | null`
    callbacks, each wrapped in try/catch so a signal failure is
    non-fatal. Default runs (API route, CLI) pass no signals, so D/E/F
    don't fire there.
- **Resolve / re-raise:** a CSM can dismiss a flag; it stays resolved
  for a per-flag **re-raise period**, then re-fires. State lives in the
  `flag-resolutions` KV row; periods live in settings.

The current flags (for reference — also in the root `README.md`):

| Flag | Meaning | Class |
|---|---|---|
| A | No publishing (past cadence + 14d) | book |
| B | No login in 14d+ | book |
| C | 25%+ below subscriber tier | book |
| D | Frustration signal (last 30d) | signal |
| E | No contact in 90+ days | signal |
| F | Notable news on contact/company | signal |
| G | CSM-self-flagged Yellow/Red (HubSpot) | book |
| H | Stale contact (> threshold days) | book |

## Steps (adding flag "I")

The type system forces most of these — two of the records are exhaustive
`Record<RiskFlagCode, …>`, so a missing case is a **compile error**
(that's intentional; lean on it).

### 1. Extend the flag-code union

`src/lib/types.ts:210` — add `"I"` to `RiskFlagCode`.

### 2. Add its re-raise default

`src/lib/data/settings-types.ts` (~`:393`) — add `I: { re_raise_days: N }`
to the `flags` record. `0` = never re-raise. TS forces this because the
map is a full `Record<RiskFlagCode, FlagPeriod>`.

> **Gotcha:** the settings map has a runtime `?? 14` fallback
> (`settings.ts:141`), so *forgetting* this default won't fail the build
> — it'll silently apply a 14-day period. Don't rely on the fallback.

### 3. Add its priority weight

`at-risk.ts` — `priorityScore`'s `weights` record (~`:289`), a full
`Record<RiskFlagCode, number>`. TS forces this one, so you can't miss it.

### 4. Implement the rule

**If book-of-business:** write a pure helper and push it in the loop.

```ts
// near the other flag helpers (flagA :90 … flagH :161)
export function flagI(c: Customer, now: Date): RiskFlag | null {
  if (!/* your condition */) return null;
  return { code: "I", label: "Short label", detail: "Why it fired." };
}
```
Then add it to the per-customer evaluation loop (~`:359`, alongside
`flagA(c)`…). Keep it a **pure function with no I/O** so it stays
unit-testable like its siblings.

**If signal-based:** add an optional callback to the `SignalSource`
interface (`:221`) and invoke it inside the try/catch signal block
(~`:370`). Leave it out of the default (no-signals) callers.

### 5. (Optional) recommend an action

Add a branch to `recommendedAction` (`:262`) so the UI suggests the right
next step when flag I is the top flag.

## Verify

```bash
npx tsc --noEmit    # will complain until steps 1–3 are all done
```

Run the engine headless against a real book (see
[the engines/CLI section](../../CLAUDE.md#engines-and-headless-runs)):

```bash
CSM_NAME=Your_Handle npm run run:at-risk        # one CSM
npm run run:at-risk -- --all                     # whole company
```

It prints a human summary to stderr and full JSON to stdout — confirm
flag I appears on the accounts you expect and that resolving it (via the
UI or `/api/flag-resolutions`) suppresses it for the re-raise window.

## Related files

- Resolve store: `src/lib/data/flag-resolutions.ts`
- Resolve API: `src/app/api/flag-resolutions/route.ts`
- Shared math the flags reuse: `src/lib/customer-helpers.ts`
  (`lastContacted` for H, `subUtilFraction` for C) — use these, don't
  recompute, so every surface agrees.
