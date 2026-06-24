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
  normalizeSubscribers,
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
