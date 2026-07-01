"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Client island for /settings/customer-folders. Renders:
 *
 *   • a Scan Drive button + last-scan summary
 *   • a review table with per-folder candidate dropdowns + skip
 *   • an Apply approved button
 *
 * Interaction model:
 *   - Scan → server populates the review queue in KV. UI reflects it.
 *   - CSM adjusts selections inline (no autosave — kept in local state).
 *   - Apply → sends all locally-modified selections + tells the
 *     server to write approved rows to HubSpot. Server responds with
 *     tallies + the sweep's canonical state, which we mirror.
 */

interface WorkspaceIndexRow {
  workspace_id: string;
  workspace_name: string | null;
  company_name: string | null;
  has_folder: boolean;
}

interface Candidate {
  workspace_id: string;
  matched_via: "company_name" | "workspace_name";
  matched_value: string;
  score: number;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
}

interface QueueRow {
  folder_id: string;
  folder_name: string;
  folder_url: string;
  candidates: Candidate[];
  selection:
    | { kind: "pending" }
    | { kind: "approved"; workspace_id: string }
    | { kind: "skipped" };
  first_seen_at: string;
  applied_at?: string;
  applied_workspace_id?: string;
}

interface ScanSummary {
  ran_at: string;
  folders_scanned: number;
  folders_new: number;
  folders_auto_matched: number;
  folders_needs_review: number;
  folders_no_candidate: number;
  folders_skipped_already_set: number;
  truncated: boolean;
}

interface GetResponse {
  last_scan_at: string | null;
  last_scan_summary: ScanSummary | null;
  queue: QueueRow[];
}

interface ApplyResponse {
  ok: boolean;
  applied: number;
  skipped_already_set: number;
  failed: number;
  errors: Array<{ folder_id: string; workspace_id: string; error: string }>;
}

type LocalSelection =
  | { kind: "pending" }
  | { kind: "approved"; workspace_id: string }
  | { kind: "skipped" };

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const CONFIDENCE_COLOR: Record<Candidate["confidence"], string> = {
  high: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
  none: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
};

export function CustomerFoldersReview({
  workspaces,
}: {
  workspaces: WorkspaceIndexRow[];
}) {
  const [state, setState] = useState<GetResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Local per-folder selection edits, keyed by folder_id. Flushed on
  // Apply; a fresh scan wipes them (the incoming queue is canonical).
  const [edits, setEdits] = useState<Record<string, LocalSelection>>({});

  const workspaceLookup = useMemo(() => {
    return new Map(workspaces.map((w) => [w.workspace_id, w]));
  }, [workspaces]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/csm/customer-folders/scan", {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState((await r.json()) as GetResponse);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runScan(): Promise<void> {
    setScanning(true);
    setMessage("Scanning Drive… this can take a minute for a big shared folder.");
    try {
      const r = await fetch("/api/csm/customer-folders/scan", {
        method: "POST",
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        folders_scanned?: number;
        folders_new?: number;
        folders_auto_matched?: number;
        folders_needs_review?: number;
        folders_no_candidate?: number;
        folders_skipped_already_set?: number;
        truncated?: boolean;
        needs_reconsent?: boolean;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        throw new Error(
          (j.needs_reconsent
            ? "drive.readonly not granted — reconnect Google at /settings/gmail. "
            : "") + (j.error ?? `HTTP ${r.status}`)
        );
      }
      setEdits({});
      setMessage(
        `Scanned ${j.folders_scanned ?? 0} folders — ` +
          `${j.folders_auto_matched ?? 0} auto-matched, ` +
          `${j.folders_needs_review ?? 0} need review, ` +
          `${j.folders_no_candidate ?? 0} no candidate, ` +
          `${j.folders_skipped_already_set ?? 0} already linked` +
          (j.truncated ? " (truncated — more folders exist)" : "") +
          "."
      );
      await refresh();
    } catch (e) {
      setMessage(`Scan failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setScanning(false);
    }
  }

  async function apply(): Promise<void> {
    setApplying(true);
    setMessage(null);
    try {
      const selections = Object.entries(edits).map(([folder_id, sel]) =>
        sel.kind === "approved"
          ? {
              folder_id,
              selection: "approved" as const,
              workspace_id: sel.workspace_id,
            }
          : {
              folder_id,
              selection: sel.kind as "skipped" | "pending",
            }
      );
      const r = await fetch("/api/csm/customer-folders/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections }),
      });
      const j = (await r.json().catch(() => ({}))) as ApplyResponse & {
        error?: string;
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setEdits({});
      const errFragment =
        j.failed > 0
          ? ` · ${j.failed} failed (${j.errors.slice(0, 2).map((e) => e.error.slice(0, 60)).join("; ")})`
          : "";
      setMessage(
        `Applied ${j.applied}, skipped ${j.skipped_already_set} already-linked${errFragment}.`
      );
      await refresh();
    } catch (e) {
      setMessage(`Apply failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setApplying(false);
    }
  }

  const queue = state?.queue ?? [];
  const summary = state?.last_scan_summary ?? null;
  const pendingCount = queue.filter(
    (r) => !r.applied_at && effectiveSelection(r, edits).kind === "pending"
  ).length;
  const approvedUnappliedCount = queue.filter(
    (r) => !r.applied_at && effectiveSelection(r, edits).kind === "approved"
  ).length;

  return (
    <div className="space-y-4">
      <div className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={scanning || applying}
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "↻ Scan Drive"}
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={scanning || applying || approvedUnappliedCount === 0}
            className="px-3 py-1.5 bg-emerald-600 text-white rounded-md text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            title={
              approvedUnappliedCount === 0
                ? "Nothing to apply — approve at least one row first."
                : `Write ${approvedUnappliedCount} approved match${
                    approvedUnappliedCount === 1 ? "" : "es"
                  } to HubSpot`
            }
          >
            {applying
              ? "Applying…"
              : `Apply approved (${approvedUnappliedCount})`}
          </button>
          <span className="text-xs text-muted">
            Last scan: <strong>{fmtRelative(state?.last_scan_at ?? null)}</strong>
            {summary ? (
              <>
                {" · "}
                {summary.folders_scanned} folder{summary.folders_scanned === 1 ? "" : "s"} ·{" "}
                {pendingCount} needs review ·{" "}
                {approvedUnappliedCount} approved
              </>
            ) : null}
          </span>
        </div>
        {message ? (
          <div className="text-xs text-muted bg-canvas/40 border border-border rounded-md px-3 py-2">
            {message}
          </div>
        ) : null}
        {loadError ? (
          <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md px-3 py-2">
            Couldn&rsquo;t load queue: {loadError}
          </div>
        ) : null}
      </div>

      {queue.length === 0 ? (
        <p className="text-sm text-muted">
          No folders in the queue yet. Click <strong>Scan Drive</strong> to populate it.
        </p>
      ) : (
        <div className="bg-surface rounded-xl border border-border shadow-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted border-b border-border">
                <th className="px-3 py-2 font-medium">Folder</th>
                <th className="px-3 py-2 font-medium">Match</th>
                <th className="px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {queue.map((row) => (
                <QueueRowView
                  key={row.folder_id}
                  row={row}
                  workspaceLookup={workspaceLookup}
                  workspaces={workspaces}
                  edit={edits[row.folder_id]}
                  onChange={(sel) =>
                    setEdits((prev) => ({ ...prev, [row.folder_id]: sel }))
                  }
                  onClearEdit={() =>
                    setEdits((prev) => {
                      const next = { ...prev };
                      delete next[row.folder_id];
                      return next;
                    })
                  }
                  disabled={scanning || applying}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function effectiveSelection(
  row: QueueRow,
  edits: Record<string, LocalSelection>
): LocalSelection {
  return edits[row.folder_id] ?? row.selection;
}

function QueueRowView({
  row,
  workspaceLookup,
  workspaces,
  edit,
  onChange,
  onClearEdit,
  disabled,
}: {
  row: QueueRow;
  workspaceLookup: Map<string, WorkspaceIndexRow>;
  workspaces: WorkspaceIndexRow[];
  edit: LocalSelection | undefined;
  onChange: (sel: LocalSelection) => void;
  onClearEdit: () => void;
  disabled: boolean;
}) {
  const selection = edit ?? row.selection;
  const isApplied = Boolean(row.applied_at);
  const isSkipped = selection.kind === "skipped";
  const isApproved = selection.kind === "approved";

  // Dropdown options: the top candidates + "Other customer…" +
  // "Skip." Sorted by score already in the API. Applied rows show
  // a read-only "Linked to X" chip instead of the picker.
  return (
    <tr className={isApplied ? "opacity-70" : ""}>
      <td className="px-3 py-2 align-top">
        <div className="font-medium text-fg break-words">{row.folder_name}</div>
        <a
          href={row.folder_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline break-all"
        >
          Open in Drive ↗
        </a>
      </td>
      <td className="px-3 py-2 align-top">
        {row.candidates.length === 0 ? (
          <span className="text-xs text-muted italic">
            No candidate matches
          </span>
        ) : (
          <ul className="space-y-1">
            {row.candidates.slice(0, 3).map((cand) => {
              const ws = workspaceLookup.get(cand.workspace_id);
              const isChosen =
                selection.kind === "approved" &&
                selection.workspace_id === cand.workspace_id;
              return (
                <li
                  key={cand.workspace_id}
                  className="flex items-baseline gap-2 text-xs"
                >
                  <span
                    className={`inline-block w-14 text-center px-1.5 py-0.5 rounded font-semibold ${CONFIDENCE_COLOR[cand.confidence]}`}
                  >
                    {cand.confidence}
                  </span>
                  <span
                    className={
                      isChosen ? "text-fg font-medium" : "text-muted"
                    }
                  >
                    {ws?.company_name ?? ws?.workspace_name ?? cand.workspace_id}
                  </span>
                  <span className="text-[10px] text-subtle italic">
                    {cand.reason}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {isApplied ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">
            ✓ Linked to{" "}
            {workspaceLookup.get(row.applied_workspace_id ?? "")?.company_name ??
              row.applied_workspace_id ??
              "?"}
          </span>
        ) : (
          <div className="flex flex-col gap-1">
            <select
              value={
                selection.kind === "approved"
                  ? selection.workspace_id
                  : selection.kind === "skipped"
                    ? "__skip__"
                    : ""
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") onChange({ kind: "pending" });
                else if (v === "__skip__") onChange({ kind: "skipped" });
                else onChange({ kind: "approved", workspace_id: v });
              }}
              disabled={disabled}
              className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg min-w-[220px] disabled:opacity-50"
            >
              <option value="">— pending —</option>
              <option value="__skip__">Skip (unrelated / test)</option>
              <optgroup label="Suggested">
                {row.candidates.map((cand) => {
                  const ws = workspaceLookup.get(cand.workspace_id);
                  return (
                    <option key={cand.workspace_id} value={cand.workspace_id}>
                      {ws?.company_name ??
                        ws?.workspace_name ??
                        cand.workspace_id}
                      {" — "}
                      {cand.confidence}
                    </option>
                  );
                })}
              </optgroup>
              <optgroup label="All customers (blank folder only)">
                {workspaces
                  .filter((w) => !w.has_folder)
                  .filter(
                    (w) =>
                      !row.candidates.some(
                        (c) => c.workspace_id === w.workspace_id
                      )
                  )
                  .sort((a, b) => {
                    const an = (a.company_name ?? a.workspace_name ?? "").toLowerCase();
                    const bn = (b.company_name ?? b.workspace_name ?? "").toLowerCase();
                    return an.localeCompare(bn);
                  })
                  .map((w) => (
                    <option key={w.workspace_id} value={w.workspace_id}>
                      {w.company_name ?? w.workspace_name ?? w.workspace_id}
                    </option>
                  ))}
              </optgroup>
            </select>
            {edit ? (
              <button
                type="button"
                onClick={onClearEdit}
                className="text-[10px] text-muted hover:text-fg self-start"
              >
                Revert
              </button>
            ) : null}
            {isSkipped && !edit ? (
              <span className="text-[10px] text-subtle italic">
                Sticky — will stay skipped on future scans
              </span>
            ) : null}
            {isApproved && !edit ? (
              <span className="text-[10px] text-emerald-700 dark:text-emerald-300">
                Ready to apply
              </span>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}
