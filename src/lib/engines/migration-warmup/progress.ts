import type { MigrationPlan } from "./types";

/**
 * Read-only progress state for a warmup plan the CSM already generated.
 *
 * Pure derivation from (plan, start_date, now). No side effects, no
 * KV, no persistence — the caller (the /csm/migration-warmup result
 * page) passes in the plan it just produced and the start-date the
 * CSM typed. Same shape whether the ramp is future, in-flight, or
 * complete; `phase` tells the UI which branch to render.
 *
 * Plan duration is `max(schedules.total_weeks)` × 7 days across the
 * lists in the plan — a customer warming multiple lists in parallel
 * finishes when the slowest list finishes. total_weeks is already
 * populated by [`generateSchedule`](./engine.ts).
 */

export type WarmupPhase = "not_started" | "in_progress" | "complete";

export interface WarmupProgress {
  /** Echo of the input start_date, YYYY-MM-DD. */
  start_date: string;
  /** Today's date at compute time, YYYY-MM-DD (UTC). */
  today: string;
  /** Plan length in calendar days: max(total_weeks) × 7. */
  total_days: number;
  /** Days from start_date to today, clamped to [0, total_days]. */
  days_elapsed: number;
  /** total_days - days_elapsed, clamped to [0, total_days]. */
  days_remaining: number;
  /** 0-100, rounded to nearest integer. */
  progress_pct: number;
  /** start_date + total_days, YYYY-MM-DD. */
  projected_end_date: string;
  /** Total weeks in the plan (= max(schedules.total_weeks)). */
  total_weeks: number;
  /** Current week (1-indexed), clamped to [0, total_weeks]. 0 = not
   *  started yet. */
  current_week: number;
  phase: WarmupPhase;
}

/** Parse a YYYY-MM-DD string as UTC midnight. Rejects malformed input
 *  by returning null — the caller is expected to fall back to
 *  today's date. */
function parseYmd(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function computeWarmupProgress(
  plan: MigrationPlan,
  startDate: string,
  now: Date = new Date()
): WarmupProgress {
  // Plan duration in weeks — a multi-list plan finishes when the
  // slowest list finishes, so we take the max. Falls back to 0 if
  // the plan has no schedules (defensive; buildPlan wouldn't
  // normally produce that).
  const totalWeeks = plan.schedules.reduce(
    (m, s) => Math.max(m, s.total_weeks),
    0
  );
  const totalDays = totalWeeks * 7;

  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const todayYmd = toYmd(todayUtc);
  // Fall back to today (UTC midnight) — not `now`'s wall-clock time —
  // so a malformed date input reads as day 0 of the ramp rather than
  // "-18h elapsed" which would mis-classify as not_started.
  const start = parseYmd(startDate) ?? todayUtc;
  const startYmd = toYmd(start);

  const rawElapsed = daysBetween(start, todayUtc);
  const daysElapsed = Math.max(0, Math.min(totalDays, rawElapsed));
  const daysRemaining = Math.max(0, totalDays - daysElapsed);
  const progressPct =
    totalDays > 0 ? Math.round((daysElapsed / totalDays) * 100) : 0;

  const projectedEnd = addDays(start, totalDays);

  // Current week bucket. Day 0 = "just starting week 1"; day 7 = week
  // 2. Clamped to [0, totalWeeks] so a plan that ran over doesn't
  // report week 99 of 12.
  let currentWeek = 0;
  if (rawElapsed >= 0) {
    currentWeek = Math.min(totalWeeks, Math.floor(daysElapsed / 7) + 1);
  }

  let phase: WarmupPhase = "in_progress";
  if (rawElapsed < 0) phase = "not_started";
  else if (rawElapsed >= totalDays) phase = "complete";

  return {
    start_date: startYmd,
    today: todayYmd,
    total_days: totalDays,
    days_elapsed: daysElapsed,
    days_remaining: daysRemaining,
    progress_pct: progressPct,
    projected_end_date: toYmd(projectedEnd),
    total_weeks: totalWeeks,
    current_week: currentWeek,
    phase,
  };
}
