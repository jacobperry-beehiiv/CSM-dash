"use client";

import type { MigrationPlan } from "@/lib/engines/migration-warmup/types";
import { computeWarmupProgress } from "@/lib/engines/migration-warmup/progress";
import { fmtDate } from "./format";

/**
 * Inline render of a generated migration plan + a prominent
 * "Open in Google Sheets" CTA. Shown after a successful submit
 * on /csm/migration-warmup.
 *
 * Layout follows the Python tool's terminal pretty-print: one
 * card per list with the week-by-week batch table. CSMs use this
 * view to sanity-check the plan before sharing the sheet.
 *
 * Progress panel sits above the list cards — reads the warmup
 * start date the CSM entered on the form, computes day N of Y +
 * projected end via [[computeWarmupProgress]]. Purely derived; no
 * KV, no persistence — recomputes on every render from the plan
 * object we already have in hand.
 */
export function MigrationWarmupResult({
  sheet,
  plan,
  warmupStartDate,
  onReset,
}: {
  sheet: { id: string; name: string; webViewLink: string };
  plan: MigrationPlan;
  warmupStartDate: string;
  onReset: () => void;
}) {
  const progress = computeWarmupProgress(plan, warmupStartDate);
  return (
    <div className="space-y-5">
      <section className="bg-surface rounded-xl border border-border shadow-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-fg">
              {plan.customer_name} — schedule generated
            </h2>
            <p className="text-xs text-muted mt-1">
              Sheet created in the customer&rsquo;s Drive folder. The
              breakdown below mirrors what was written.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={sheet.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
            >
              Open in Google Sheets ↗
            </a>
            <button
              type="button"
              onClick={onReset}
              className="px-3 py-2 border border-border-strong rounded-md text-sm hover:bg-canvas"
            >
              Generate another
            </button>
          </div>
        </div>
      </section>

      <ProgressPanel progress={progress} />

      {plan.schedules.map((s) => (
        <section
          key={s.name}
          className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-3"
        >
          <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="text-base font-semibold text-fg">{s.name}</h3>
            <span className="text-xs text-muted">
              {s.subscribers.toLocaleString()} · {s.cadence} · {s.tier} ·{" "}
              <span className="capitalize">{s.approach}</span> · ETA {s.eta}
            </span>
          </header>
          {s.flags.length > 0 ? (
            <ul className="text-[11px] text-amber-700 dark:text-amber-300 list-disc list-inside">
              {s.flags.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Week</th>
                  <th className="py-1.5 pr-3 font-medium">Batches</th>
                  <th className="py-1.5 pr-3 font-medium">Week total</th>
                  <th className="py-1.5 pr-3 font-medium">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {s.weeks
                  .filter((w) => w.batches.length > 0)
                  .map((w) => (
                    <tr key={w.number} className="border-b border-border/50">
                      <td className="py-1.5 pr-3 whitespace-nowrap font-medium text-fg">
                        {w.label}
                      </td>
                      <td className="py-1.5 pr-3 text-muted">
                        {w.batches
                          .map((b) => b.size.toLocaleString())
                          .join(" · ")}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {w.week_total.toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">
                        {w.cumulative.toLocaleString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Smart-warming progress card. Three visual branches keyed by
 * `progress.phase`:
 *
 *   • not_started — start_date is in the future, so no bar. Just
 *     "Starts in N days" + projected end.
 *   • in_progress — start / today / end row on top, progress bar
 *     in the middle, week + days-remaining row below.
 *   • complete — green pill + summary line.
 */
function ProgressPanel({
  progress,
}: {
  progress: ReturnType<typeof computeWarmupProgress>;
}) {
  const startedLabel = fmtDate(progress.start_date);
  const endLabel = fmtDate(progress.projected_end_date);

  if (progress.total_days === 0) {
    // Defensive — buildPlan usually produces at least one schedule.
    return null;
  }

  if (progress.phase === "not_started") {
    const daysUntil = Math.max(
      1,
      Math.round(
        (new Date(`${progress.start_date}T00:00:00Z`).getTime() -
          new Date(`${progress.today}T00:00:00Z`).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    );
    return (
      <section className="rounded-xl border border-border bg-surface shadow-card p-5">
        <h3 className="text-sm font-semibold text-fg uppercase tracking-wide">
          Smart warming
        </h3>
        <div className="mt-2 flex items-baseline gap-2 flex-wrap">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/40 text-blue-900 dark:text-blue-200">
            Starts in {daysUntil} day{daysUntil === 1 ? "" : "s"}
          </span>
          <span className="text-xs text-muted">
            {startedLabel} → projected {endLabel} ·{" "}
            {progress.total_weeks}-week ramp
          </span>
        </div>
      </section>
    );
  }

  if (progress.phase === "complete") {
    return (
      <section className="rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-500/5 shadow-card p-5">
        <h3 className="text-sm font-semibold text-fg uppercase tracking-wide">
          Smart warming
        </h3>
        <div className="mt-2 flex items-baseline gap-2 flex-wrap">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-100 dark:bg-emerald-500/20 border-emerald-300 dark:border-emerald-500/40 text-emerald-900 dark:text-emerald-200">
            Ramp complete
          </span>
          <span className="text-xs text-muted">
            {startedLabel} → {endLabel} · {progress.total_weeks}-week ramp
          </span>
        </div>
      </section>
    );
  }

  // in_progress
  return (
    <section className="rounded-xl border border-border bg-surface shadow-card p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-fg uppercase tracking-wide">
          Smart warming progress
        </h3>
        <span className="text-xs text-muted">
          Started {startedLabel} · Projected end {endLabel}
        </span>
      </div>
      <div>
        <div className="h-3 rounded-full bg-canvas border border-border overflow-hidden">
          <div
            className="h-full bg-accent"
            style={{ width: `${progress.progress_pct}%` }}
            aria-label={`Progress ${progress.progress_pct}%`}
          />
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-3 flex-wrap text-xs">
          <span className="text-fg">
            Day <strong className="tabular-nums">{progress.days_elapsed}</strong> of{" "}
            <strong className="tabular-nums">{progress.total_days}</strong>{" "}
            <span className="text-muted">
              ({progress.progress_pct}%) · Week {progress.current_week} of{" "}
              {progress.total_weeks}
            </span>
          </span>
          <span className="text-muted tabular-nums">
            {progress.days_remaining} day
            {progress.days_remaining === 1 ? "" : "s"} remaining
          </span>
        </div>
      </div>
    </section>
  );
}
