#!/usr/bin/env tsx
/**
 * Unit tests for computeWarmupProgress. Same lightweight
 * pass/fail harness as engine.test.ts — no test framework, just
 * `console.log(PASS)/console.log(FAIL)` + exit code.
 *
 * Run with `npx tsx src/lib/engines/migration-warmup/__tests__/progress.test.ts`.
 */

import { computeWarmupProgress } from "../progress";
import type { MigrationPlan } from "../types";

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
    failures.push(
      `${name}\n   got=${JSON.stringify(got)}\n   expected=${JSON.stringify(expected)}`
    );
    console.log(`FAIL  ${name}`);
    console.log(`      got=${JSON.stringify(got)}`);
    console.log(`      expected=${JSON.stringify(expected)}`);
  }
}

/** Minimal MigrationPlan for progress computation — only
 *  schedules[].total_weeks is read; all other fields are ignored. */
function plan(totalWeeks: number, extraSchedules: number[] = []): MigrationPlan {
  return {
    customer_name: "Test",
    structure: "separate",
    drive_folder_url: null,
    schedules: [
      {
        name: "L1",
        subscribers: 100000,
        cadence: "daily",
        sends_per_week: 7,
        open_rate: null,
        tier: "Medium",
        approach: "standard",
        total_weeks: totalWeeks,
        eta: "",
        flags: [],
        weeks: [],
      },
      ...extraSchedules.map((tw, i) => ({
        name: `L${i + 2}`,
        subscribers: 100000,
        cadence: "daily",
        sends_per_week: 7,
        open_rate: null,
        tier: "Medium",
        approach: "standard" as const,
        total_weeks: tw,
        eta: "",
        flags: [],
        weeks: [],
      })),
    ],
  };
}

// Fixed "now" so tests are deterministic. Use a mid-day UTC time
// to catch any accidental local-time arithmetic.
const NOW = new Date("2026-07-15T18:30:00Z");

// -------- start = today, 12-week plan --------
{
  const p = computeWarmupProgress(plan(12), "2026-07-15", NOW);
  check("start=today: phase", p.phase, "in_progress");
  check("start=today: days_elapsed", p.days_elapsed, 0);
  check("start=today: days_remaining", p.days_remaining, 84);
  check("start=today: total_days", p.total_days, 84);
  check("start=today: progress_pct", p.progress_pct, 0);
  check("start=today: current_week", p.current_week, 1);
  check(
    "start=today: projected_end_date",
    p.projected_end_date,
    "2026-10-07"
  );
}

// -------- 30 days in, 12-week plan --------
{
  const p = computeWarmupProgress(plan(12), "2026-06-15", NOW);
  check("30d in: phase", p.phase, "in_progress");
  check("30d in: days_elapsed", p.days_elapsed, 30);
  check("30d in: days_remaining", p.days_remaining, 54);
  check("30d in: progress_pct", p.progress_pct, 36);
  check("30d in: current_week", p.current_week, 5);
}

// -------- Future start (5 days out) --------
{
  const p = computeWarmupProgress(plan(12), "2026-07-20", NOW);
  check("future: phase", p.phase, "not_started");
  check("future: days_elapsed", p.days_elapsed, 0);
  check("future: days_remaining", p.days_remaining, 84);
  check("future: progress_pct", p.progress_pct, 0);
  check("future: current_week", p.current_week, 0);
}

// -------- Ramp complete (started 200d ago, 12-week plan) --------
{
  const p = computeWarmupProgress(plan(12), "2025-12-27", NOW);
  check("complete: phase", p.phase, "complete");
  check("complete: days_elapsed", p.days_elapsed, 84);
  check("complete: days_remaining", p.days_remaining, 0);
  check("complete: progress_pct", p.progress_pct, 100);
  check("complete: current_week", p.current_week, 12);
}

// -------- Multi-list plan: takes max(total_weeks) --------
{
  // Slow list = 20 weeks; other lists are shorter. Plan duration =
  // 20 weeks = 140 days.
  const p = computeWarmupProgress(plan(8, [20, 12]), "2026-07-15", NOW);
  check("multi-list: total_weeks", p.total_weeks, 20);
  check("multi-list: total_days", p.total_days, 140);
  check(
    "multi-list: projected_end",
    p.projected_end_date,
    "2026-12-02"
  );
}

// -------- Malformed start date defaults to today (defensive) --------
{
  const p = computeWarmupProgress(plan(12), "not-a-date", NOW);
  check(
    "malformed date: falls back to today",
    p.start_date,
    "2026-07-15"
  );
  check("malformed date: phase in_progress", p.phase, "in_progress");
}

// -------- Empty plan (no schedules): total_days = 0, phase complete --------
{
  const emptyPlan: MigrationPlan = {
    customer_name: "Test",
    structure: "separate",
    drive_folder_url: null,
    schedules: [],
  };
  const p = computeWarmupProgress(emptyPlan, "2026-07-15", NOW);
  check("empty plan: total_weeks", p.total_weeks, 0);
  check("empty plan: total_days", p.total_days, 0);
  check("empty plan: progress_pct", p.progress_pct, 0);
  // rawElapsed = 0, totalDays = 0 → 0 >= 0 → complete. Acceptable
  // defensive behavior; empty plans shouldn't reach the UI anyway.
  check("empty plan: phase", p.phase, "complete");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}\n`);
  process.exit(1);
}
