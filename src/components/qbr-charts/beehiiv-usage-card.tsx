"use client";

import { forwardRef, useEffect, useState } from "react";
import { BeehiivLogo } from "@/components/beehiiv-logo";
import { beehiiv } from "@/lib/qbr-charts/colors";
import type { BeehiivUsageReport } from "@/lib/qbr-charts/beehiiv-usage";

/**
 * Two-column Y/N table matching the manual QBR-slide layout: one row
 * per feature, plus a trailing SCORE row. Same 960px card chrome as
 * ChartCard so it sits alongside the tiles and drops cleanly into the
 * PNG export flow.
 *
 * Data comes from GET /api/qbr-charts/beehiiv-usage on workspace
 * pick. Fetched-once-per-workspace (no cache-busting) — CSMs pull
 * the QBR window all in one sitting and don't need mid-run
 * refresh; a workspace change re-fetches.
 *
 * Renders `—` for every row while loading so the chrome, title,
 * and column headers all measure at their final size (avoids a
 * layout jump when data lands and keeps the PNG snapshot stable
 * if capture races the fetch).
 */
export const BeehiivUsageCard = forwardRef<
  HTMLDivElement,
  {
    workspaceId: string | null;
    /** Optional — when set, the engine returns this publication's
     *  logo + name; otherwise it falls back to the workspace's
     *  earliest-created publication with a logo. Threaded from
     *  the QBR tab's PublicationPicker so the header reflects the
     *  same selection the charts scope to. */
    publicationId?: string | null;
  }
>(function BeehiivUsageCard({ workspaceId, publicationId = null }, ref) {
  const [report, setReport] = useState<BeehiivUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setReport(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setReport(null);
    setError(null);
    const params = new URLSearchParams({ workspace_id: workspaceId });
    if (publicationId) params.set("publication_id", publicationId);
    fetch(`/api/qbr-charts/beehiiv-usage?${params.toString()}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as BeehiivUsageReport;
      })
      .then((body) => {
        if (!cancelled) setReport(body);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, publicationId]);

  return (
    <div
      ref={ref}
      className="bg-surface border border-border rounded-xl shadow-card p-6 mx-auto"
      style={{ maxWidth: 960 }}
    >
      <header className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3 min-w-0">
          {report?.publication ? (
            /* Publication logo — proxied through /api/qbr-charts/logo
             * so html-to-image can inline it in the exported PNG
             * (beehiiv's media CDN doesn't set CORS headers).
             * crossOrigin="anonymous" pairs with our same-origin
             * response so the browser doesn't taint the canvas.
             * eslint-disable-next-line @next/next/no-img-element —
             * next/image would need a remote pattern whitelist for
             * every possible publication host; a plain <img> works. */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={`/api/qbr-charts/logo/${report.publication.publication_id}`}
              alt={
                report.publication.publication_name
                  ? `${report.publication.publication_name} logo`
                  : "Publication logo"
              }
              width={48}
              height={48}
              crossOrigin="anonymous"
              className="h-12 w-12 rounded-md object-contain bg-canvas/60 border border-border shrink-0"
            />
          ) : null}
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-fg tracking-tight">
              beehiiv Usage
            </h2>
            <p className="text-sm text-muted mt-1">
              {report?.publication?.publication_name
                ? report.publication.publication_name
                : "Feature-adoption checklist for this workspace."}
            </p>
          </div>
        </div>
        <div
          className="flex items-center gap-2 text-[11px] text-muted shrink-0"
          aria-label="beehiiv badge"
        >
          <BeehiivLogo className="h-4 w-4" />
          <span style={{ color: beehiiv.purple, fontWeight: 600 }}>
            beehiiv
          </span>
        </div>
      </header>
      {error ? (
        <div className="text-sm text-red-600 dark:text-red-400 italic">
          {error}
        </div>
      ) : (
        <UsageTable report={report} />
      )}
      <p className="mt-4 text-[11px] text-subtle">
        Live from beehiiv Postgres · one EXISTS check per feature scoped
        through the workspace&rsquo;s publications.
      </p>
    </div>
  );
});

function UsageTable({ report }: { report: BeehiivUsageReport | null }) {
  // While loading, render the same feature list as a scaffold so the
  // card height is stable and the export doesn't snapshot a
  // half-populated table. `active` is null → "—" rendering.
  const rows = report
    ? report.features.map((f) => ({ label: f.label, active: f.active }))
    : PLACEHOLDER_LABELS.map((label) => ({
        label,
        active: null as boolean | null,
      }));
  return (
    <table className="w-full text-sm border-separate border-spacing-0">
      <thead>
        <tr className="text-left">
          <th className="px-3 py-2 border border-border font-semibold text-fg bg-canvas/40">
            Feature
          </th>
          <th className="px-3 py-2 border border-border font-semibold text-fg bg-canvas/40 w-32 text-center">
            In use?
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td className="px-3 py-2 border border-border">{r.label}</td>
            <td className="px-3 py-2 border border-border text-center tabular-nums">
              {r.active === null ? (
                <span className="text-subtle">—</span>
              ) : r.active ? (
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                  Y
                </span>
              ) : (
                <span className="font-semibold text-muted">N</span>
              )}
            </td>
          </tr>
        ))}
        <tr>
          <td className="px-3 py-2 border border-border font-semibold bg-canvas/40">
            SCORE
          </td>
          <td className="px-3 py-2 border border-border text-center tabular-nums font-semibold bg-canvas/40">
            {report ? `${report.score}%` : "—"}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Fallback labels rendered while the fetch is in flight — must
 *  match the server's FEATURES order in beehiiv-usage.ts so the
 *  card height stays identical between placeholder and real data. */
const PLACEHOLDER_LABELS = [
  "Settings Complete",
  "Welcome Email",
  "A/B Testing",
  "Subscriber Tags",
  "Segments",
  "Automations",
  "Polls",
  "Survey Forms",
  "Referral Program",
  "Recommendations",
  "Ad Network",
  "Slack Community",
];
