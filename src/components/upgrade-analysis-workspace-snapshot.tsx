"use client";

import { useEffect, useState } from "react";
import type {
  AnalysisWindow,
  DeliverabilitySnapshot,
  DeliverabilitySnapshotRow,
  WorkspaceSnapshot,
  WorkspaceSnapshotPubRow,
} from "@/lib/engines/upgrade-analysis/types";
import { fmtNumber } from "./format";

/**
 * Workspace-wide D&C snapshot table. Sits at the top of the
 * `UpgradeAnalysisPanelForWorkspace` wrapper, above the single-pub
 * picker. Top row is the workspace aggregate (summed counters →
 * fixed D&C ratios), body is one row per publication.
 *
 * Same 7 metrics as the single-pub tile:
 *   Open Rate · Delivery Rate · Hard Bounce Rate · Soft Bounce Rate ·
 *   Unsub Rate · Spam Reported Rate · Deferral Rate
 *
 * Each cell renders a small colored chip based on the same fixed
 * D&C threshold — matches the single-pub snapshot so a reviewer
 * eyeballs both surfaces the same way.
 */

interface Props {
  workspaceId: string;
  analysisWindow: AnalysisWindow | null;
}

const METRIC_LABELS: Record<DeliverabilitySnapshotRow["key"], string> = {
  open_rate: "Open",
  delivery_rate: "Delivery",
  hard_bounce_rate: "Hard bounce",
  soft_bounce_rate: "Soft bounce",
  unsubscribe_rate: "Unsub",
  spam_rate: "Spam",
  deferral_rate: "Deferral",
};

const METRIC_ORDER: DeliverabilitySnapshotRow["key"][] = [
  "open_rate",
  "delivery_rate",
  "hard_bounce_rate",
  "soft_bounce_rate",
  "unsubscribe_rate",
  "spam_rate",
  "deferral_rate",
];

function pct(v: number, digits = 2): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtCell(row: DeliverabilitySnapshotRow): string {
  if (row.value == null) return "—";
  const digits =
    row.key === "spam_rate" || row.key === "hard_bounce_rate" ? 3 : 2;
  return pct(row.value, digits);
}

function cellTone(row: DeliverabilitySnapshotRow): string {
  if (row.flagged === true)
    return "text-red-700 dark:text-red-300 font-semibold";
  if (row.flagged === false) return "text-emerald-700 dark:text-emerald-300";
  return "text-subtle";
}

export function UpgradeAnalysisWorkspaceSnapshot({
  workspaceId,
  analysisWindow,
}: Props) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; snapshot: WorkspaceSnapshot }
  >({ kind: "loading" });
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const windowBody: Record<string, unknown> = {};
    if (analysisWindow?.kind === "lookback") {
      windowBody.lookback_days = analysisWindow.lookback_days;
    } else if (analysisWindow?.kind === "range") {
      windowBody.start_date = analysisWindow.start_date;
      windowBody.end_date = analysisWindow.end_date;
    }
    (async () => {
      try {
        const res = await fetch("/api/upgrade-analysis/workspace-snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId: workspaceId,
            ...windowBody,
          }),
        });
        const body = (await res.json()) as {
          ok?: boolean;
          snapshot?: WorkspaceSnapshot;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !body.snapshot) {
          setState({
            kind: "error",
            message: body.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        setState({ kind: "ready", snapshot: body.snapshot });
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Unknown error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, analysisWindow]);

  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left p-4 flex items-start justify-between gap-2 hover:bg-surface-2"
      >
        <div>
          <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
            Workspace deliverability snapshot
            {state.kind === "ready" ? (
              <SummaryChip snapshot={state.snapshot.aggregate} />
            ) : null}
          </h3>
          <p className="text-xs text-muted mt-0.5">
            {state.kind === "ready" ? (
              <>
                {state.snapshot.rows.length} publication
                {state.snapshot.rows.length === 1 ? "" : "s"} · aggregate over
                the {windowText(state.snapshot)} · same fixed D&amp;C flag
                lines as the single-pub tile.
              </>
            ) : state.kind === "loading" ? (
              <>Loading workspace snapshot…</>
            ) : (
              <>Snapshot failed to load: {state.message}</>
            )}
          </p>
        </div>
        <span
          aria-hidden="true"
          className={`text-subtle text-xs transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {open ? (
        <div className="px-4 pb-4">
          {state.kind === "loading" ? (
            <div className="text-xs text-muted italic py-2">
              Batching one ClickHouse query across all pubs — usually 3–8s.
            </div>
          ) : state.kind === "error" ? (
            <div className="text-xs text-red-700 dark:text-red-300 py-2">
              {state.message}
            </div>
          ) : (
            <SnapshotTable snapshot={state.snapshot} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function windowText(snapshot: WorkspaceSnapshot): string {
  if (snapshot.analysis_window?.kind === "range") {
    return `${snapshot.analysis_window.start_date} → ${snapshot.analysis_window.end_date}`;
  }
  return `last ${snapshot.window_days} days`;
}

function SummaryChip({ snapshot }: { snapshot: DeliverabilitySnapshot }) {
  if (snapshot.status === "flagged") {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30">
        {snapshot.flagged_count} of 7 flagged
      </span>
    );
  }
  if (snapshot.status === "clean") {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
        All 7 clean
      </span>
    );
  }
  if (snapshot.status === "low_volume") {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
        LOW VOLUME
      </span>
    );
  }
  return (
    <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-slate-500/10 text-slate-700 dark:text-slate-300 border border-slate-500/30">
      NO SEND DATA
    </span>
  );
}

function SnapshotTable({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  // Sort pubs by sent volume desc so the D&C reviewer sees the pubs
  // that matter most first. No-send pubs sink to the bottom.
  const sorted = [...snapshot.rows].sort(
    (a, b) => b.funnel.sent - a.funnel.sent
  );

  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-subtle border-b border-border/60">
            <th className="text-left font-medium py-1 pr-2">Publication</th>
            <th className="text-right font-medium py-1 pr-2">Sent</th>
            {METRIC_ORDER.map((k) => (
              <th
                key={k}
                className="text-right font-medium py-1 pr-2 whitespace-nowrap"
              >
                {METRIC_LABELS[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <AggregateRow
            snapshot={snapshot.aggregate}
            sent={snapshot.aggregate_funnel.sent}
            pubCount={snapshot.rows.length}
          />
          {sorted.map((row) => (
            <PubRow key={row.pub_id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AggregateRow({
  snapshot,
  sent,
  pubCount,
}: {
  snapshot: DeliverabilitySnapshot;
  sent: number;
  pubCount: number;
}) {
  const byKey = new Map(snapshot.rows.map((r) => [r.key, r]));
  return (
    <tr className="border-b-2 border-border bg-surface-2/60 font-semibold">
      <td className="py-1.5 pr-2 text-fg">
        <span className="uppercase tracking-wide text-[10px] text-subtle mr-1">
          Workspace ({pubCount})
        </span>
      </td>
      <td className="py-1.5 pr-2 text-right text-fg tabular-nums">
        {fmtNumber(sent)}
      </td>
      {METRIC_ORDER.map((k) => {
        const row = byKey.get(k);
        return (
          <td
            key={k}
            className={`py-1.5 pr-2 text-right tabular-nums ${
              row ? cellTone(row) : "text-subtle"
            }`}
          >
            {row ? fmtCell(row) : "—"}
          </td>
        );
      })}
    </tr>
  );
}

function PubRow({ row }: { row: WorkspaceSnapshotPubRow }) {
  const byKey = new Map(row.snapshot.rows.map((r) => [r.key, r]));
  const name = row.name?.trim() || row.pub_id;
  const noSend = row.snapshot.status === "no_data";
  const lowVol = row.snapshot.status === "low_volume";
  return (
    <tr className="border-b border-border/40">
      <td className="py-1 pr-2 text-fg">
        <div className="flex flex-col leading-tight">
          <span className="truncate max-w-[240px]">{name}</span>
          <span className="text-[10px] text-subtle">
            {row.subscribers != null ? `${fmtNumber(row.subscribers)} subs` : ""}
            {noSend
              ? " · no sends"
              : lowVol
                ? " · low volume"
                : ""}
          </span>
        </div>
      </td>
      <td className="py-1 pr-2 text-right text-fg tabular-nums">
        {fmtNumber(row.funnel.sent)}
      </td>
      {METRIC_ORDER.map((k) => {
        const cell = byKey.get(k);
        return (
          <td
            key={k}
            className={`py-1 pr-2 text-right tabular-nums ${
              cell ? cellTone(cell) : "text-subtle"
            }`}
          >
            {cell ? fmtCell(cell) : "—"}
          </td>
        );
      })}
    </tr>
  );
}
