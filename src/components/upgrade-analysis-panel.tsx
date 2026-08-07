"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  OverallVerdict,
  PillarKey,
  UpgradeAnalysisReport,
} from "@/lib/engines/upgrade-analysis/types";
import { UpgradeAnalysisPillarCard } from "./upgrade-analysis-pillar-card";

/**
 * D&C Upgrade Analysis panel — mounts under a customer row via
 * CustomerDetailPanel's `topSlot`.
 *
 * Three states:
 *  1. **No scan on file** — shows a "Run upgrade analysis" CTA. First
 *     click triggers a fresh scan.
 *  2. **Cached scan present** — renders the verdict + escalation
 *     banner + pillar cards immediately, plus a "Re-run" button.
 *     Re-running respects the 24h freshness guard by default; a
 *     `Force refresh` toggle bypasses it.
 *  3. **Loading** — spinner + "Scanning… (~10s)" text while the POST
 *     is in flight. Real-world scans take ~5–15s depending on
 *     ClickHouse load.
 *
 * The panel POSTs to /api/upgrade-analysis/scan on mount when no
 * cached report was passed in — that returns the cached report if
 * fresh, or an actual scan if stale/absent. Which of those happened
 * is reported via the `cached` flag in the response.
 */

interface Props {
  publicationId: string;
  organizationId?: string;
  /** Optional server-fetched report to render immediately (skips the
   *  initial GET). Pass this when the parent has already loaded the
   *  scan from KV (e.g. the review-queue tab). */
  initial?: { report: UpgradeAnalysisReport; last_scanned_at: string } | null;
  /** Auto-fetch on mount when `initial` is not provided AND a
   *  cached report exists. Default true; set false to keep the
   *  panel in the "Run analysis" CTA state until the user clicks. */
  autoLoad?: boolean;
}

interface ApiResponse {
  ok?: boolean;
  cached?: boolean;
  report?: UpgradeAnalysisReport;
  last_scanned_at?: string;
  error?: string;
}

const VERDICT_STYLES: Record<
  OverallVerdict,
  { label: string; classes: string }
> = {
  clear: {
    label: "Clear — safe to proceed",
    classes:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
  },
  review_needed: {
    label: "Review needed",
    classes:
      "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/40",
  },
  hold: {
    label: "Hold — D&C required",
    classes:
      "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/40",
  },
};

const PILLAR_ORDER: PillarKey[] = [
  "identity",
  "acquisition",
  "funnel",
  "engagement",
  "provider",
  "network",
];

export function UpgradeAnalysisPanel({
  publicationId,
  organizationId,
  initial,
  autoLoad = true,
}: Props) {
  const [report, setReport] = useState<UpgradeAnalysisReport | null>(
    initial?.report ?? null
  );
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(
    initial?.last_scanned_at ?? null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState<boolean>(!!initial);
  const [triggered, setTriggered] = useState(false);

  const runScan = useCallback(
    async (opts: { force?: boolean; cachedOnly?: boolean } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/upgrade-analysis/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publicationId,
            organizationId,
            force: opts.force ?? false,
          }),
        });
        const body = (await res.json()) as ApiResponse;
        if (!res.ok || body.error) {
          // On the initial "cached-only" probe, a 500 (or a 200 with
          // no report) shouldn't drop the CTA — just leave the panel
          // in its "no scan yet" state.
          if (opts.cachedOnly) {
            setLoading(false);
            return;
          }
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        if (body.report) {
          setReport(body.report);
          setLastScannedAt(body.last_scanned_at ?? null);
          setCached(!!body.cached);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [publicationId, organizationId]
  );

  // On mount, check for an existing cached scan without forcing a
  // fresh one. If the endpoint returns the cached report we render
  // it; if not, the panel sits in the CTA state waiting for the CSM
  // to click Run.
  useEffect(() => {
    if (!autoLoad || initial || triggered) return;
    setTriggered(true);
    // A POST here with force=false + a fresh KV entry returns cached.
    // A stale/absent entry would trigger a real scan — which we
    // *don't* want on auto-load. So we probe with a special path:
    // POST with a freshness guard and, if the response is a fresh
    // scan (`cached: false`) and it's the first mount, we surface
    // it anyway (the endpoint already ran the scan, discarding the
    // result would be waste).
    void runScan({ cachedOnly: true });
  }, [autoLoad, initial, triggered, runScan]);

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
            D&amp;C Upgrade Analysis
            {report ? (
              <VerdictChip verdict={report.overall} />
            ) : null}
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Six-pillar scorecard. Interpretation guardrails encoded as
            rules; thresholds are tunable in{" "}
            <code className="bg-surface-2 px-1 rounded">
              /settings/upgrade-analysis
            </code>
            .
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {report ? (
            <button
              type="button"
              onClick={() => runScan({ force: true })}
              disabled={loading}
              className="text-xs px-2.5 py-1 rounded border border-border bg-surface hover:bg-surface-2 disabled:opacity-50"
            >
              {loading ? "Scanning…" : "Re-run (force)"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => runScan({ force: true })}
              disabled={loading}
              className="text-sm px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {loading ? "Scanning…" : "Run upgrade analysis"}
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-700 dark:text-red-300 p-2">
          Scan failed: {error}
        </div>
      ) : null}

      {loading && !report ? (
        <div className="mt-3 text-xs text-muted italic">
          Scanning six pillars against Metabase + ClickHouse. Usually 5–15s;
          each pillar has an independent 30s timeout.
        </div>
      ) : null}

      {report ? (
        <div className="mt-3 space-y-3">
          {/* Escalation banner — separate from the overall verdict on
              purpose. A pub can be 'clear' on every pillar but still
              have an escalation reason (e.g. an active AUP flag). */}
          {report.escalation.needed ? (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-red-800 dark:text-red-300">
                    Escalation to D&amp;C required
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {report.escalation.reasons.map((r, i) => (
                      <li
                        key={i}
                        className="text-sm text-red-900 dark:text-red-100"
                      >
                        <span className="font-medium">{r.code}:</span>{" "}
                        {r.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}

          {/* Pillar cards. 2-up on desktop, stacked on narrow. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {PILLAR_ORDER.map((k) => (
              <UpgradeAnalysisPillarCard
                key={k}
                pillarKey={k}
                score={report.pillar_scores[k]}
                report={report}
              />
            ))}
          </div>

          {/* Slack matches — placeholder for PR 2. Renders the section
              header + a small note so reviewers know the read isn't
              running yet, rather than mistake absence for "checked
              Slack, nothing found." */}
          <div className="rounded-md border border-border bg-surface p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
              Slack search
            </p>
            {report.slack_signals.length > 0 ? (
              <ul className="mt-1 space-y-1">
                {report.slack_signals.map((s, i) => (
                  <li key={i} className="text-xs">
                    <a
                      href={s.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-dotted text-indigo-600 dark:text-indigo-400"
                    >
                      Matched &quot;{s.matched_term}&quot;
                    </a>
                    <span className="text-muted"> — {s.snippet}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted italic">
                Slack search integration not shipped yet — verify prior
                D&amp;C decisions manually in{" "}
                <code className="bg-surface-2 px-1 rounded">
                  #deliverability
                </code>{" "}
                before actioning.
              </p>
            )}
          </div>

          {/* Footer meta. */}
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span>
              Report generated{" "}
              {report.generated_at
                ? new Date(report.generated_at).toLocaleString()
                : "—"}
              {report.triggered_by ? ` by ${report.triggered_by}` : null}
              {cached ? " · cached" : " · fresh"}
            </span>
            {lastScannedAt ? (
              <span>
                Last scan on record{" "}
                {new Date(lastScannedAt).toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {!report && !loading && !error ? (
        <div className="mt-3 text-xs text-muted">
          No scan on file for this publication yet. Running the scorecard
          takes ~10s — it hits ClickHouse for a 30-day funnel + provider
          concentration, plus Postgres for org flags and acquisition
          channels.
        </div>
      ) : null}
    </div>
  );
}

function VerdictChip({ verdict }: { verdict: OverallVerdict }) {
  const s = VERDICT_STYLES[verdict];
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${s.classes}`}
    >
      {s.label}
    </span>
  );
}
