"use client";

import type { MigrationPlan } from "@/lib/engines/migration-warmup/types";

/**
 * Inline render of a generated migration plan + a prominent
 * "Open in Google Sheets" CTA. Shown after a successful submit
 * on /csm/migration-warmup.
 *
 * Layout follows the Python tool's terminal pretty-print: one
 * card per list with the week-by-week batch table. CSMs use this
 * view to sanity-check the plan before sharing the sheet.
 */
export function MigrationWarmupResult({
  sheet,
  plan,
  onReset,
}: {
  sheet: { id: string; name: string; webViewLink: string };
  plan: MigrationPlan;
  onReset: () => void;
}) {
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
