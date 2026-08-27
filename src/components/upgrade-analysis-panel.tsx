"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AnalysisWindow,
  OverallVerdict,
  PillarKey,
  UpgradeAnalysisReport,
} from "@/lib/engines/upgrade-analysis/types";
import { UpgradeAnalysisPillarCard } from "./upgrade-analysis-pillar-card";
import { UpgradeAnalysisSnapshotTile } from "./upgrade-analysis-snapshot-tile";
import { UpgradeAnalysisDateWindowPicker } from "./upgrade-analysis-date-window-picker";
import { UpgradeAnalysisWorkspaceSnapshot } from "./upgrade-analysis-workspace-snapshot";
import { useWorkspacePublications } from "@/lib/hooks/customer-publications-cache";
import { fmtNumber } from "./format";
import { zendeskSearchUrl } from "@/lib/links";

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
  /** Customer's owner email — powers the Zendesk history quick-link.
   *  Null when unknown; the button hides in that case. */
  ownerEmail?: string | null;
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
  ownerEmail = null,
}: Props) {
  const zendeskUrl = zendeskSearchUrl(ownerEmail ?? null);
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
  // Analysis window — null means "use the config default". Seeded
  // from the initial report so we render the same window it was
  // scanned in; a picker click swaps the value + kicks off a fresh
  // scan (via the picker's onChange → runScan below).
  const [window, setWindow] = useState<AnalysisWindow | null>(
    initial?.report.analysis_window ?? null
  );

  const runScan = useCallback(
    async (
      opts: {
        force?: boolean;
        cachedOnly?: boolean;
        window?: AnalysisWindow | null;
      } = {}
    ) => {
      setLoading(true);
      setError(null);
      // Explicitly-passed `window` takes precedence — a picker onChange
      // fires runScan with the new value before React has re-rendered
      // the state, so we can't rely on the state variable here.
      const activeWindow = opts.window !== undefined ? opts.window : window;
      try {
        // Build the body shape the endpoint expects. Endpoint accepts
        // either lookback_days OR (start_date, end_date), never both.
        const windowBody: Record<string, unknown> = {};
        if (activeWindow?.kind === "lookback") {
          windowBody.lookback_days = activeWindow.lookback_days;
        } else if (activeWindow?.kind === "range") {
          windowBody.start_date = activeWindow.start_date;
          windowBody.end_date = activeWindow.end_date;
        }
        const res = await fetch("/api/upgrade-analysis/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publicationId,
            organizationId,
            ownerEmail,
            force: opts.force ?? false,
            ...windowBody,
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
    [publicationId, organizationId, ownerEmail, window]
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
          {/* Analysis window picker — presets fire a scan immediately;
              custom mode holds the range until the user hits Apply. */}
          <div className="mt-2">
            <UpgradeAnalysisDateWindowPicker
              value={window}
              disabled={loading}
              onChange={(w) => {
                setWindow(w);
                // A user-initiated window change should re-scan, but
                // stay inside the freshness guard — the KV entry for
                // the new window is a distinct key, so we don't need
                // to force. Skipping force here also lets the second
                // click on the same preset serve from cache.
                void runScan({ window: w });
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {zendeskUrl ? (
            <a
              href={zendeskUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs px-2.5 py-1 rounded border border-border bg-surface hover:bg-surface-2 flex items-center gap-1"
              title={`Search Zendesk tickets for ${ownerEmail}`}
            >
              🎫 <span>Zendesk history</span>
            </a>
          ) : null}
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

          {/* D&C-aligned snapshot — fixed 7-metric flag table, above
              the pillar cards. Uses the same source-of-truth funnel
              counters the pillars read, but computes ratios against
              `sent` per the D&C spec rather than `delivered`. */}
          {report.deliverability_snapshot ? (
            <UpgradeAnalysisSnapshotTile
              snapshot={report.deliverability_snapshot}
              analysisWindow={report.analysis_window}
            />
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

          {/* Slack matches — auto-populated via the shared user-token
              search from `slack-search.ts`. Grouped by channel, newest
              first within each group; empty when nothing matched or
              when SLACK_USER_TOKEN isn't configured (helper is
              fail-open). */}
          <UpgradeAnalysisSlackMatches
            signals={report.slack_signals}
            outcome={report.slack_search ?? null}
          />

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

/**
 * Grouped Slack matches, rendered as a small card below the pillars.
 * The empty state distinguishes "we ran the read and got nothing"
 * from "no read shipped yet" — after the switch to the auto-fetch,
 * empty means no matches, which is itself useful signal.
 */
function UpgradeAnalysisSlackMatches({
  signals,
  outcome,
}: {
  signals: UpgradeAnalysisReport["slack_signals"];
  outcome: UpgradeAnalysisReport["slack_search"];
}) {
  // Older cached scans predate `slack_search`; treat absence as
  // "ok" so we don't wrongly claim a config problem.
  const status = outcome?.status ?? "ok";
  const detail = outcome?.detail;
  const [open, setOpen] = useState(false);
  // Group by channel_id → keep the newest-first order within each
  // channel (the engine already sorted the array). A Map preserves
  // insertion order which corresponds to newest-across-all-channels
  // first, so channels with the most-recent hit surface at the top.
  const grouped = new Map<
    string,
    { channelName: string | undefined; hits: typeof signals }
  >();
  for (const hit of signals) {
    const bucket = grouped.get(hit.channel_id);
    if (bucket) {
      bucket.hits.push(hit);
    } else {
      grouped.set(hit.channel_id, {
        channelName: hit.channel_name,
        hits: [hit],
      });
    }
  }

  return (
    <div className="rounded-md border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left p-3 flex items-center justify-between gap-2 hover:bg-surface-2"
      >
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
            Slack search
          </p>
          {signals.length > 0 ? (
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30">
              {signals.length} match{signals.length === 1 ? "" : "es"}
            </span>
          ) : status !== "ok" && status !== "no_query" ? (
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
              needs setup
            </span>
          ) : null}
        </div>
        <span
          aria-hidden="true"
          className={`text-subtle text-xs transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open ? (
        <div className="px-3 pb-3">
      {signals.length === 0 ? (
        <SlackEmptyState status={status} detail={detail} />
      ) : (
        <div className="mt-2 space-y-2">
          {Array.from(grouped.entries()).map(([channelId, group]) => (
            <div key={channelId}>
              <p className="text-[10px] uppercase tracking-wide text-subtle">
                #{group.channelName ?? channelId}
              </p>
              <ul className="mt-0.5 space-y-1">
                {group.hits.map((h) => (
                  <li key={h.ts} className="text-xs leading-snug">
                    <a
                      href={h.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-dotted text-indigo-600 dark:text-indigo-400 mr-1"
                    >
                      ↗ {formatSlackTs(h.ts)}
                    </a>
                    <span className="text-subtle italic mr-1">
                      matched &quot;{h.matched_term}&quot;
                    </span>
                    <span className="text-muted">— {h.snippet}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
        </div>
      ) : null}
    </div>
  );
}

/** Diagnostic empty state — makes it obvious WHY the section is
 *  empty (real "no matches" vs. a config problem the user can fix). */
function SlackEmptyState({
  status,
  detail,
}: {
  status: NonNullable<UpgradeAnalysisReport["slack_search"]>["status"];
  detail?: string;
}) {
  if (status === "ok" || status === "no_query") {
    return (
      <p className="mt-1 text-xs text-muted italic">
        No prior D&amp;C decisions found in Slack for this pub.
      </p>
    );
  }
  const cls =
    status === "not_configured"
      ? "border-slate-500/40 bg-slate-500/10 text-slate-800 dark:text-slate-200"
      : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200";
  return (
    <div className={`mt-1 rounded border ${cls} p-2 text-xs`}>
      <p className="font-semibold">
        {status === "not_configured"
          ? detail === "user_token_required"
            ? "Slack search needs a user token"
            : "Slack search not configured"
          : status === "auth_error"
            ? `Slack search failed — auth (${detail ?? "unknown"})`
            : status === "timeout"
              ? "Slack search timed out"
              : `Slack search failed (${detail ?? "unknown"})`}
      </p>
      <p className="mt-0.5 opacity-90">
        {status === "not_configured" ? (
          detail === "user_token_required" ? (
            <>
              A bot token is set, but Slack&rsquo;s{" "}
              <code className="bg-surface-2 px-1 rounded">search.messages</code>{" "}
              endpoint only accepts user tokens (
              <code className="bg-surface-2 px-1 rounded">xoxp-…</code>). Add{" "}
              <code className="bg-surface-2 px-1 rounded">search:read</code>{" "}
              to the app&rsquo;s User Token Scopes, reinstall to get an{" "}
              <code className="bg-surface-2 px-1 rounded">xoxp-</code> token,
              and set{" "}
              <code className="bg-surface-2 px-1 rounded">SLACK_USER_TOKEN</code>{" "}
              in Vercel.
            </>
          ) : (
            <>
              Set{" "}
              <code className="bg-surface-2 px-1 rounded">SLACK_USER_TOKEN</code>{" "}
              (user token with{" "}
              <code className="bg-surface-2 px-1 rounded">search:read</code>) in
              Vercel envs and redeploy.
            </>
          )
        ) : status === "auth_error" ? (
          <>
            The shipped token is missing a search scope or was rotated.
            For the bot token: add{" "}
            <code className="bg-surface-2 px-1 rounded">search:read.public</code>
            {" "}to Bot Token Scopes and reinstall. For a user token: add{" "}
            <code className="bg-surface-2 px-1 rounded">search:read</code>{" "}
            to User Token Scopes, reinstall, and update the env.
          </>
        ) : status === "timeout" ? (
          <>Slack API didn&rsquo;t respond in time. Re-run the scan.</>
        ) : (
          <>Slack API returned an error. Re-run the scan; if it persists, check the app&rsquo;s OAuth page.</>
        )}
      </p>
    </div>
  );
}

/** Slack's `ts` is a UNIX epoch (float). Render as a short date so
 *  reviewers can eyeball recency without opening every permalink. */
function formatSlackTs(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return ts;
  return new Date(seconds * 1000).toLocaleDateString();
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

/**
 * Workspace-scoped wrapper — the pillar SQL scores a single
 * publication, but the customer-detail-panel mount only knows the
 * workspace_id (organization). Enterprise customers can own many
 * publications, and the score for "flagship newsletter" differs from
 * "internal test publication," so we render a picker and let the CSM
 * pick which pub to score.
 *
 * Behavior:
 *  - Fetches the workspace's publications via the shared cache hook
 *    (same source of truth the "Publications" section below uses, so
 *    no duplicate round-trip).
 *  - Defaults the selection to the largest publication by subscribers
 *    — that's almost always the one D&C would want to score first.
 *  - Renders the picker inline in the panel header when the workspace
 *    has more than one publication; hides it for single-pub workspaces
 *    (auto-selected).
 *  - Delegates to the underlying `UpgradeAnalysisPanel` once a
 *    publication is selected, passing workspaceId as `organizationId`
 *    so the network pillar runs against the right org.
 */
export function UpgradeAnalysisPanelForWorkspace({
  workspaceId,
  ownerEmail = null,
}: {
  workspaceId: string;
  /** Owner email surfaced to the inner panel as the anchor for the
   *  Zendesk history button — D&C's next tab after they read the
   *  scorecard. Null when we don't have it (button is hidden). */
  ownerEmail?: string | null;
}) {
  const state = useWorkspacePublications(workspaceId);
  const pubs = Array.isArray(state) ? state : null;
  const error = state instanceof Error ? state.message : null;

  // Default = largest by subscribers. Falls back to the first entry
  // when subscribers are all null (e.g. a fresh workspace).
  const defaultPubId = useMemo(() => {
    if (!pubs || pubs.length === 0) return null;
    const sorted = [...pubs].sort(
      (a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0)
    );
    return sorted[0]?.publication_id ?? null;
  }, [pubs]);

  const [selectedPubId, setSelectedPubId] = useState<string | null>(null);
  const effectivePubId = selectedPubId ?? defaultPubId;

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 p-4 text-xs text-red-700 dark:text-red-300">
        D&amp;C Upgrade Analysis unavailable — publications list failed to
        load: {error}
      </div>
    );
  }
  if (pubs === null) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 p-4 text-xs text-muted">
        Loading publications for D&amp;C Upgrade Analysis…
      </div>
    );
  }
  if (pubs.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 p-4 text-xs text-muted">
        D&amp;C Upgrade Analysis can&rsquo;t run — no publications found
        under this workspace.
      </div>
    );
  }
  if (!effectivePubId) return null;

  return (
    <div className="space-y-3">
      {/* Workspace-wide D&C snapshot: 7-metric table across every
          pub in the workspace + an aggregate row. Sits at the top
          so the reviewer sees the whole book of business before
          drilling into a single pub. Fetches its own data from the
          workspace-snapshot endpoint on mount. */}
      <UpgradeAnalysisWorkspaceSnapshot
        workspaceId={workspaceId}
        analysisWindow={null}
      />
      {pubs.length > 1 ? (
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="text-subtle">Scan publication:</span>
          <select
            value={effectivePubId}
            onChange={(e) => setSelectedPubId(e.currentTarget.value)}
            className="flex-1 max-w-md text-xs px-2 py-1 rounded border border-border bg-surface"
          >
            {pubs.map((p) => (
              <option key={p.publication_id} value={p.publication_id}>
                {p.publication_name || p.publication_id}
                {p.subscribers != null ? ` — ${fmtNumber(p.subscribers)} subs` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <UpgradeAnalysisPanel
        // Remount the inner panel when the selection changes so its
        // cached-scan probe re-runs against the newly-picked pub id
        // instead of the previous one.
        key={effectivePubId}
        publicationId={effectivePubId}
        organizationId={workspaceId}
        ownerEmail={ownerEmail}
      />
    </div>
  );
}
