#!/usr/bin/env tsx
/**
 * Cross-language verification harness for the migration-warmup
 * engine port. Mirrors test_migration_warmup.py — same worked
 * examples + invariant sweep, line by line, so the TS engine is
 * byte-identical to the Python reference.
 *
 * Run with `npx tsx src/lib/engines/migration-warmup/__tests__/engine.test.ts`.
 * Exits 0 on all-pass, 1 with a summary if anything fails.
 */

import {
  generateSchedule,
  minimumSafeWeeks,
  normalizeCadence,
  normalizeSubscribers,
  solveForDeadline,
  tierFor,
} from "../engine";
import type { ListInput } from "../types";

function cumulatives(sched: ReturnType<typeof generateSchedule>): number[] {
  return sched.weeks.filter((w) => w.batches.length > 0).map((w) => w.cumulative);
}
function weekTotals(sched: ReturnType<typeof generateSchedule>): number[] {
  return sched.weeks
    .filter((w) => w.batches.length > 0)
    .map((w) => w.week_total);
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check<T>(name: string, got: T, expected: T) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}\n   got=${JSON.stringify(got)}\n   expected=${JSON.stringify(expected)}`);
    console.log(`FAIL  ${name}`);
    console.log(`      got=${JSON.stringify(got)}`);
    console.log(`      expected=${JSON.stringify(expected)}`);
  }
}

function li(
  name: string,
  subscribers: number,
  cadence: string,
  opts: Partial<ListInput> = {}
): ListInput {
  return { name, subscribers, cadence, ...opts };
}

// ----------------------------------------------------------------- //
// 1. FIDELITY to worked examples in SKILL.md
// ----------------------------------------------------------------- //

// Small daily (OR>=30%): "W1 20k | W2 70k | W3 170k | W4 remainder" for 250k.
{
  const s = generateSchedule(li("Small Daily", 250000, "daily", { open_rate: 0.38 }));
  check("Small daily cumulative W1-W3", cumulatives(s).slice(0, 3), [20000, 70000, 170000]);
  check("Small daily ends at list size", cumulatives(s).slice(-1)[0], 250000);
}

// Small 1x/week (OR>=30%): cumulative 5k,15k,35k,65k,105k,remainder for 250k.
{
  const s = generateSchedule(li("Small 1x", 250000, "1x/week", { open_rate: 0.38 }));
  check("Small 1x cumulative", cumulatives(s).slice(0, 5), [5000, 15000, 35000, 65000, 105000]);
  check("Small 1x week totals", weekTotals(s).slice(0, 5), [5000, 10000, 20000, 30000, 40000]);
}

// Medium daily: W1 30k | W2 -> 80k (cap) | W3 -> 200k (cap) | W4 -> 400k (cap)
{
  const s = generateSchedule(li("Medium Daily", 750000, "daily", { open_rate: 0.4 }));
  check("Medium daily cumulative W1-W4", cumulatives(s).slice(0, 4), [30000, 80000, 200000, 400000]);
  check("Medium daily ends at list size", cumulatives(s).slice(-1)[0], 750000);
}

// Large daily W1 = 40k (4 × 10k); caps W2-W5.
{
  const s = generateSchedule(li("Large Daily", 1500000, "daily", { open_rate: 0.4 }));
  check("Large daily W1", cumulatives(s)[0], 40000);
  check("Large daily caps W2-W5", cumulatives(s).slice(1, 5), [100000, 200000, 400000, 750000]);
}

// Micro 1x (OR>=30%): batches 5k,10k,20k,30k → cumulative 5,15,35,65 for 75k.
{
  const s = generateSchedule(li("Micro 1x", 75000, "1x/week", { open_rate: 0.4 }));
  check("Micro 1x cumulative", cumulatives(s), [5000, 15000, 35000, 65000, 75000]);
}

// Medium W1 by cadence band.
{
  check(
    "Medium W1 @4x",
    cumulatives(generateSchedule(li("m", 500000, "4x/week", { open_rate: 0.4 })))[0],
    30000
  );
  check(
    "Medium W1 @2x",
    cumulatives(generateSchedule(li("m", 500000, "2x/week", { open_rate: 0.4 })))[0],
    20000
  );
  check(
    "Medium W1 @1x",
    cumulatives(generateSchedule(li("m", 500000, "1x/week", { open_rate: 0.4 })))[0],
    15000
  );
}

// ----------------------------------------------------------------- //
// 2. INVARIANTS across a sweep
// ----------------------------------------------------------------- //

const sweepSizes = [5000, 60000, 75000, 120000, 250000, 400000, 750000, 1200000, 2000000, 3500000];
const sweepCadence = ["daily", "4x/week", "3x/week", "2x/week", "1x/week", "bi-weekly"];
const sweepOr: Array<number | null> = [0.45, 0.25, null];

let invariantFailures = 0;
let totalCases = 0;
for (const size of sweepSizes) {
  for (const cad of sweepCadence) {
    for (const orr of sweepOr) {
      totalCases += 1;
      let sched: ReturnType<typeof generateSchedule>;
      try {
        sched = generateSchedule(li("x", size, cad, { open_rate: orr }));
      } catch (e) {
        // Acceptable only for huge lists on bi-weekly (cadence too
        // slow). Anything else is a real failure.
        if (size >= 2000000 && cad === "bi-weekly") continue;
        invariantFailures += 1;
        console.log(
          `  ! unexpected error ${size}/${cad}/${orr}: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
        continue;
      }
      const subs = normalizeSubscribers(size);
      const cums = sched.weeks.filter((w) => w.batches.length > 0).map((w) => w.cumulative);
      // strictly non-decreasing
      const monoOk = cums.every((c, i) => i === 0 || c >= cums[i - 1]);
      // ends exactly at list size
      const endsOk = cums[cums.length - 1] === subs;
      // determinism: same input → same output
      const second = generateSchedule(li("x", size, cad, { open_rate: orr }));
      const determOk = JSON.stringify(sched) === JSON.stringify(second);
      if (!monoOk || !endsOk || !determOk) {
        invariantFailures += 1;
        console.log(
          `  ! invariant fail ${size}/${cad}/${orr}: mono=${monoOk} ends=${endsOk} determ=${determOk}`
        );
      }
    }
  }
}
check("Invariants across sweep", invariantFailures, 0);
console.log(`(swept ${totalCases} cases)`);

// ----------------------------------------------------------------- //
// Deadline solving
// ----------------------------------------------------------------- //

// A deadline looser than the natural ramp must change nothing — we
// only compress when asked to, never pre-emptively.
{
  const base = generateSchedule(li("Loose", 150_000, "3x/week", { open_rate: 0.4 }));
  const withLooseDeadline = generateSchedule(
    li("Loose", 150_000, "3x/week", {
      open_rate: 0.4,
      deadline_weeks: base.total_weeks + 10,
    })
  );
  check("loose deadline: approach unchanged", withLooseDeadline.approach, "standard");
  check(
    "loose deadline: schedule unchanged",
    cumulatives(withLooseDeadline),
    cumulatives(base)
  );
}

// A feasible-but-tight deadline must actually land inside it. This is
// the behaviour the flat 1.25x multiplier didn't guarantee.
{
  // 400k @ 1x/week has ~4 weeks of headroom between the cap floor and
  // the natural ramp. High-cadence senders have none — their standard
  // schedule already sits on the cap ladder — so a compression test
  // has to pick a low-cadence case to have anything to compress.
  const subs = 400_000;
  const { spw } = normalizeCadence("1x/week");
  const floor = minimumSafeWeeks(tierFor(subs), spw, subs);
  const base = generateSchedule(li("Tight", subs, "1x/week", { open_rate: 0.4 }));
  // Pick a target strictly between the floor and the natural ramp, so
  // it's genuinely a compression and genuinely achievable.
  const target = Math.floor((floor + base.total_weeks) / 2);
  if (target > floor && target < base.total_weeks) {
    const tight = generateSchedule(
      li("Tight", subs, "1x/week", { open_rate: 0.4, deadline_weeks: target })
    );
    check("tight deadline: approach aggressive", tight.approach, "aggressive");
    check("tight deadline: fits within deadline", tight.total_weeks <= target, true);
    check(
      "tight deadline: still completes the list",
      tight.weeks[tight.weeks.length - 1].cumulative,
      subs
    );
  }
}

// An impossible deadline must be reported, not silently missed. The
// returned schedule is the fastest SAFE plan, not a schedule that
// breaches caps to hit the date.
{
  const subs = 500_000;
  const { spw } = normalizeCadence("1x/week");
  const floor = minimumSafeWeeks(tierFor(subs), spw, subs);
  const impossible = Math.max(1, floor - 3);
  const sol = solveForDeadline(tierFor(subs), spw, subs, impossible);
  check("impossible deadline: not achievable", sol.achievable, false);
  check("impossible deadline: reports the floor", sol.minimum_weeks, floor);
  check("impossible deadline: returns floor-length plan", sol.weeks, floor);

  const sched = generateSchedule(
    li("Impossible", subs, "1x/week", {
      open_rate: 0.4,
      deadline_weeks: impossible,
    })
  );
  check(
    "impossible deadline: warns the CSM",
    sched.flags.some((f) => f.includes("NOT achievable safely")),
    true
  );
  check(
    "impossible deadline: does not fake the date",
    sched.total_weeks >= floor,
    true
  );
}

// The safety property that matters: compression must never breach a
// cap. generateSchedule already asserts this internally, so a sweep
// that completes without throwing IS the assertion.
{
  let swept = 0;
  let threw = 0;
  for (const subs of [30_000, 120_000, 400_000, 900_000]) {
    for (const cadence of ["1x/week", "2x/week", "3x/week", "daily"]) {
      for (const deadline of [1, 2, 4, 8, 16]) {
        swept += 1;
        try {
          generateSchedule(
            li("Sweep", subs, cadence, {
              open_rate: 0.4,
              deadline_weeks: deadline,
            })
          );
        } catch {
          threw += 1;
        }
      }
    }
  }
  check("deadline sweep: no cap breaches", threw, 0);
  console.log(`(swept ${swept} deadline cases)`);
}

// ----------------------------------------------------------------- //
// Summary
// ----------------------------------------------------------------- //

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("");
  console.log("Failures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
