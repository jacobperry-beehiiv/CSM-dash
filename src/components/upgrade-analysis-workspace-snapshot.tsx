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
  /** Owner email surfaced in the D&C escalation draft. Optional —
   *  when absent the draft omits the Owner line rather than
   *  rendering "unknown". */
  ownerEmail?: string | null;
  /** Human-readable org / workspace name for the draft header. Falls
   *  back to the workspace id when omitted. */
  workspaceName?: string | null;
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
  ownerEmail = null,
  workspaceName = null,
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
            <SnapshotTable
              snapshot={state.snapshot}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              ownerEmail={ownerEmail}
            />
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

function SnapshotTable({
  snapshot,
  workspaceId,
  workspaceName,
  ownerEmail,
}: {
  snapshot: WorkspaceSnapshot;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
}) {
  // Sort pubs by sent volume desc so the D&C reviewer sees the pubs
  // that matter most first. No-send pubs sink to the bottom.
  const sorted = [...snapshot.rows].sort(
    (a, b) => b.funnel.sent - a.funnel.sent
  );

  // Selection state for the bulk-copy affordance. Stored as a Set of
  // raw pub_ids (the strings the workspace-snapshot endpoint
  // returned) so header-checkbox / row-checkbox / copy-selected all
  // agree on identity without any prefix-normalization.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const allIds = sorted.map((r) => r.pub_id);
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selected.has(id));

  function toggleOne(pubId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pubId)) next.delete(pubId);
      else next.add(pubId);
      return next;
    });
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allIds));
  }

  async function copySelected() {
    // Emit in the table's current sort order — makes the copied list
    // read the same as what the CSM sees on-screen. Strip the `pub_`
    // prefix so the output pastes cleanly into Metabase / SQL where
    // the raw uuid is expected — matching the existing
    // CopyPubIdsButton's default format on the AM tabs.
    const ordered = allIds.filter((id) => selected.has(id));
    const raw = ordered.map((id) => (id.startsWith("pub_") ? id.slice(4) : id));
    const text = raw.join(",");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(
        `Copy ${raw.length} publication ID${raw.length === 1 ? "" : "s"}:`,
        text
      );
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[11px] text-subtle">
          {selected.size > 0
            ? `${selected.size} of ${sorted.length} selected`
            : `${sorted.length} publication${sorted.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          onClick={copySelected}
          disabled={selected.size === 0}
          className="text-[11px] px-2 py-0.5 rounded border border-border bg-surface hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          title="Copy the selected publication IDs to the clipboard as a comma-separated list"
        >
          {copied
            ? "Copied ✓"
            : `📋 Copy pub IDs${
                selected.size > 0 ? ` (${selected.size})` : ""
              }`}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-subtle border-b border-border/60">
              <th className="py-1 pr-2 w-6">
                <input
                  type="checkbox"
                  aria-label="Select all publications"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="cursor-pointer"
                />
              </th>
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
              {/* Actions column — used by the row-level Draft Slack
                  button when flagged. Header stays blank. */}
              <th className="py-1 w-24" />
            </tr>
          </thead>
          <tbody>
            <AggregateRow
              snapshot={snapshot.aggregate}
              sent={snapshot.aggregate_funnel.sent}
              pubCount={snapshot.rows.length}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              ownerEmail={ownerEmail}
              allRows={snapshot.rows}
              windowText={windowText(snapshot)}
            />
            {sorted.map((row) => (
              <PubRow
                key={row.pub_id}
                row={row}
                workspaceName={workspaceName}
                ownerEmail={ownerEmail}
                windowText={windowText(snapshot)}
                selected={selected.has(row.pub_id)}
                onToggle={() => toggleOne(row.pub_id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AggregateRow({
  snapshot,
  sent,
  pubCount,
  workspaceId,
  workspaceName,
  ownerEmail,
  allRows,
  windowText: winText,
}: {
  snapshot: DeliverabilitySnapshot;
  sent: number;
  pubCount: number;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  allRows: WorkspaceSnapshotPubRow[];
  windowText: string;
}) {
  const byKey = new Map(snapshot.rows.map((r) => [r.key, r]));
  return (
    <tr className="border-b-2 border-border bg-surface-2/60 font-semibold">
      {/* Empty checkbox cell — the aggregate row isn't itself a
          publication so it doesn't participate in the bulk-copy
          selection. Keeps the column count aligned. */}
      <td className="py-1.5" />
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
      <td className="py-1.5 text-right">
        {snapshot.status === "flagged" ? (
          <DraftSlackButton
            getMessage={() =>
              buildWorkspaceEscalationMessage({
                workspaceId,
                workspaceName,
                ownerEmail,
                windowText: winText,
                aggregate: snapshot,
                allRows,
              })
            }
          />
        ) : null}
      </td>
    </tr>
  );
}

function PubRow({
  row,
  workspaceName,
  ownerEmail,
  windowText: winText,
  selected,
  onToggle,
}: {
  row: WorkspaceSnapshotPubRow;
  workspaceName: string | null;
  ownerEmail: string | null;
  windowText: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const byKey = new Map(row.snapshot.rows.map((r) => [r.key, r]));
  const name = row.name?.trim() || row.pub_id;
  const noSend = row.snapshot.status === "no_data";
  const lowVol = row.snapshot.status === "low_volume";
  return (
    <tr className="border-b border-border/40">
      <td className="py-1 pr-2">
        <input
          type="checkbox"
          aria-label={`Select ${name}`}
          checked={selected}
          onChange={onToggle}
          className="cursor-pointer"
        />
      </td>
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
      <td className="py-1 text-right">
        {row.snapshot.status === "flagged" ? (
          <DraftSlackButton
            getMessage={() =>
              buildPubEscalationMessage({
                pubRow: row,
                workspaceName,
                ownerEmail,
                windowText: winText,
              })
            }
          />
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Small button that copies a pre-formatted D&C escalation message
 * to the clipboard. Deliberately doesn't post to Slack directly —
 * the CSM opens the right channel + reviews the draft themselves,
 * matching how Richard's #dc-review posts get authored today.
 * "Copied" state clears after ~2s.
 */
function DraftSlackButton({
  getMessage,
}: {
  getMessage: () => string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getMessage());
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard write can fail (permissions / non-secure
          // context). Fall back to a prompt so the user still gets
          // the text.
          window.prompt("Copy this D&C escalation draft:", getMessage());
        }
      }}
      title="Copy a D&C escalation draft for this row to the clipboard"
      className="text-[10px] px-2 py-0.5 rounded border border-border bg-surface hover:bg-surface-2 whitespace-nowrap"
    >
      {copied ? "Copied ✓" : "Draft Slack"}
    </button>
  );
}

// ─── Message templates ──────────────────────────────────────────────────

/** Format one row's cell value for the message body. */
function fmtRateForMessage(row: DeliverabilitySnapshotRow): string {
  if (row.value == null) return "—";
  const digits =
    row.key === "spam_rate" || row.key === "hard_bounce_rate" ? 3 : 2;
  return `${(row.value * 100).toFixed(digits)}%`;
}

/** Format one row's threshold with the direction glyph. */
function fmtThresholdForMessage(row: DeliverabilitySnapshotRow): string {
  const digits = row.key === "spam_rate" ? 3 : 2;
  const value = `${(row.threshold * 100).toFixed(digits)}%`;
  if (row.key === "open_rate") return `< ${value}`;
  if (row.key === "delivery_rate") return `≤ ${value}`;
  return `≥ ${value}`;
}

/** Human label for a metric row in the message body. */
const METRIC_LABELS_LONG: Record<DeliverabilitySnapshotRow["key"], string> = {
  open_rate: "Open rate",
  delivery_rate: "Delivery rate",
  hard_bounce_rate: "Hard bounce rate",
  soft_bounce_rate: "Soft bounce rate",
  unsubscribe_rate: "Unsubscribe rate",
  spam_rate: "Spam-reported rate",
  deferral_rate: "Deferral rate",
};

/** Human "which of the 7 are clean" summary — surfaced in the
 *  message so the reviewer sees the negative space, not just the
 *  flagged metrics. Richard's post explicitly calls out
 *  "Everything else is clean across all five: opens 34-41%,
 *  delivery >99%, …" — that context is what turns a raw flag
 *  dump into a real read. */
function cleanSummary(snapshot: DeliverabilitySnapshot): string {
  const clean = snapshot.rows.filter((r) => r.flagged === false);
  if (clean.length === 0) return "";
  return clean
    .map(
      (r) => `${METRIC_LABELS_LONG[r.key].toLowerCase()} ${fmtRateForMessage(r)}`
    )
    .join(", ");
}

/** One-liner describing what flagged, phrased like a person would.
 *  Callers append their own "here's what I think is going on"
 *  paragraph in the placeholder below. */
function flaggedPhrase(snapshot: DeliverabilitySnapshot, windowText: string): string {
  const flagged = snapshot.rows.filter((r) => r.flagged === true);
  if (flagged.length === 0) return "";
  const parts = flagged
    .map(
      (r) =>
        `${METRIC_LABELS_LONG[r.key].toLowerCase()} at ${fmtRateForMessage(r)} (flags at ${fmtThresholdForMessage(r)})`
    );
  return `Over the ${windowText}, ${joinList(parts)} on the D&C snapshot.`;
}

/** Grammatical join — "a", "a and b", "a, b, and c". Uses the Oxford
 *  comma because it matches how the reference post reads. */
function joinList(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** Escalation draft for a single publication. Modeled on Richard's
 *  #dc-review post shape: a lede that summarizes what I've observed
 *  in prose, a compact metadata block, a "concerns" section that
 *  reads like a person laying out their read of each flag (with a
 *  placeholder for the mechanism the CSM has already checked), a
 *  "what's clean" line for negative space, and a conversational
 *  ask phrased as an actual question. The placeholders are the
 *  spots where the CSM adds one-to-two sentences of their own
 *  investigation — they're what turn the scaffold from a dump into
 *  a real message.  */
function buildPubEscalationMessage(args: {
  pubRow: WorkspaceSnapshotPubRow;
  workspaceName: string | null;
  ownerEmail: string | null;
  windowText: string;
}): string {
  const { pubRow, workspaceName, ownerEmail, windowText } = args;
  const pubName = pubRow.name?.trim() || pubRow.pub_id;
  const orgLine = workspaceName ? `*Org:* ${workspaceName}` : "";
  const ownerLine = ownerEmail
    ? `*Owner:* <mailto:${ownerEmail}|${ownerEmail}>`
    : "";
  const metadata = [
    `*Pub:* ${pubName} — \`${pubRow.pub_id}\` (${fmtNumber(pubRow.funnel.sent)} sent · ${windowText})`,
    [orgLine, ownerLine].filter(Boolean).join(" | "),
  ].filter(Boolean);

  const flaggedRows = pubRow.snapshot.rows.filter((r) => r.flagged === true);
  const concernBlocks = flaggedRows
    .map((r, i) => {
      const num = flaggedRows.length > 1 ? ` ${i + 1}` : "";
      return `> *Concern${num} — ${METRIC_LABELS_LONG[r.key]}:* ${METRIC_LABELS_LONG[r.key]} is running at *${fmtRateForMessage(r)}* against a D&C flag line of ${fmtThresholdForMessage(r)}. _[Say what you've already checked here — daily distribution, whether it looks like a spike vs. sustained baseline, what the customer told you about their sending model, anything corroborating or contradicting the number.]_`;
    })
    .join("\n>\n");

  const cleanLine = cleanSummary(pubRow.snapshot);
  const cleanBlock = cleanLine
    ? `> *Everything else looks clean:* ${cleanLine} — no Slack or AUP compliance history.`
    : "";

  const lede = `${flaggedPhrase(pubRow.snapshot, windowText)} Wanted a read from D&C on whether this is upgrade-blocking or a case where the customer's sending model is naturally higher-noise but not non-compliant.`;

  return [
    `*Enterprise Upgrade Review Request — ${pubName}*`,
    ``,
    lede,
    ``,
    ...metadata,
    ``,
    concernBlocks,
    cleanBlock ? `>` : "",
    cleanBlock,
    cleanBlock ? `>` : "",
    `> *Ask:* Given _[the customer's stated list-hygiene practice, or the mechanism you've verified]_, does D&C read this as an upgrade blocker, or is the pattern explainable by the sending model on its own?`,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

/** Workspace-wide escalation — the shape Richard's actual post
 *  used for the 5-pub Woodford Newsletters case. Lede describes
 *  the pattern across pubs in prose; pubs are listed inline with
 *  their identifiers; thread block walks the reviewer through the
 *  concerns, the corroborating clean signals, and closes with a
 *  question. */
function buildWorkspaceEscalationMessage(args: {
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  windowText: string;
  aggregate: DeliverabilitySnapshot;
  allRows: WorkspaceSnapshotPubRow[];
}): string {
  const {
    workspaceId,
    workspaceName,
    ownerEmail,
    windowText,
    aggregate,
    allRows,
  } = args;
  const nameOrId = workspaceName?.trim() || workspaceId;
  const flaggedPubs = allRows.filter((r) => r.snapshot.status === "flagged");
  const totalPubs = allRows.length;

  const pubsInline = flaggedPubs.length
    ? flaggedPubs
        .map((r) => `${r.name?.trim() || r.pub_id}: \`${r.pub_id}\``)
        .join(", ")
    : allRows
        .slice(0, 5)
        .map((r) => `${r.name?.trim() || r.pub_id}: \`${r.pub_id}\``)
        .join(", ");

  const orgLine = `*Org:* ${nameOrId}`;
  const ownerLine = ownerEmail
    ? `*Owner:* <mailto:${ownerEmail}|${ownerEmail}>`
    : "";

  const flaggedRows = aggregate.rows.filter((r) => r.flagged === true);
  const scope =
    flaggedPubs.length > 0
      ? `across ${flaggedPubs.length === totalPubs ? "all" : flaggedPubs.length} of the ${totalPubs} pubs`
      : `on the workspace-wide aggregate`;

  const lede = `${flaggedPhrase(aggregate, windowText)} Pattern is ${scope}. Wanted a read from D&C on whether the disclosed acquisition/sending model is just naturally higher-churn or something more concerning on our side.`;

  const concernBlocks = flaggedRows
    .map((r, i) => {
      const num = flaggedRows.length > 1 ? ` ${i + 1}` : "";
      return `> *Concern${num} — ${METRIC_LABELS_LONG[r.key]}:* Aggregate ${METRIC_LABELS_LONG[r.key].toLowerCase()} is *${fmtRateForMessage(r)}* against a D&C flag line of ${fmtThresholdForMessage(r)}. _[Note whether it's sustained low-grade across every pub or driven by one or two, whether the customer's questionnaire explains it, and how you read the mechanism.]_`;
    })
    .join("\n>\n");

  const cleanLine = cleanSummary(aggregate);
  const cleanBlock = cleanLine
    ? `> *What's clean across the workspace:* ${cleanLine} — no Slack or AUP compliance history.`
    : "";

  const perPubBlock = flaggedPubs.length
    ? `> *Per-pub flag counts:*\n${flaggedPubs
        .sort((a, b) => b.snapshot.flagged_count - a.snapshot.flagged_count)
        .map(
          (r) =>
            `> • ${r.name?.trim() || r.pub_id}: ${r.snapshot.flagged_count} of 7 flagged (${fmtNumber(r.funnel.sent)} sent)`
        )
        .join("\n")}`
    : "";

  return [
    `*Enterprise Upgrade Review Request — ${nameOrId} (${totalPubs} pubs)*`,
    ``,
    lede,
    ``,
    `*Pubs:* ${pubsInline}`,
    [orgLine, ownerLine].filter(Boolean).join(" | "),
    ``,
    concernBlocks,
    perPubBlock ? `>` : "",
    perPubBlock,
    cleanBlock ? `>` : "",
    cleanBlock,
    `>`,
    `> *Ask:* Given _[the customer's stated list-hygiene practice or the mechanism you've verified]_, does D&C see this pattern as an upgrade blocker, or is this a case where the disclosed acquisition/sending model is simply higher-noise by nature but not non-compliant?`,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}
