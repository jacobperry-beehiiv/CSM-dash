"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomerLabelRow } from "@/lib/data/gmail-customer-labels";
import type { GmailLabel } from "@/lib/integrations/gmail-labels";

/**
 * Client island for /settings/gmail-labels. Renders one row per
 * customer in the viewer's book with their inferred (or manually-set)
 * Gmail label, plus controls to override, clear, or re-scan.
 *
 * State flow:
 *   1. Mount → GET /api/csm/gmail-labels (mapping + labels + scan ts).
 *   2. "Re-scan my whole book" → POST /api/csm/gmail-labels/scan,
 *      then GET to refresh.
 *   3. Per-row dropdown change → PUT /api/csm/gmail-labels with
 *      action=set + label_id.
 *   4. "Clear" → PUT with action=clear.
 *   5. Per-row "Re-scan" → POST /api/csm/gmail-labels/scan/[ws],
 *      then merge the returned row into local state.
 */

interface CustomerSummary {
  workspace_id: string;
  workspace_name: string | null;
  company_name: string | null;
  owner_email: string | null;
}

interface Props {
  customers: CustomerSummary[];
}

interface ApiState {
  mapping: Record<string, CustomerLabelRow>;
  last_full_scan: string | null;
  labels: GmailLabel[];
  labels_error: string | null;
  /** True when the active user's stored Google token carries
   *  gmail.modify. When false, the dashboard skips the label-list
   *  call entirely and the banner directs to re-consent. */
  has_modify_scope: boolean;
}

const EMPTY_STATE: ApiState = {
  mapping: {},
  last_full_scan: null,
  labels: [],
  labels_error: null,
  has_modify_scope: true,
};

export function GmailLabelsManager({ customers }: Props) {
  const [state, setState] = useState<ApiState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch("/api/csm/gmail-labels", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ApiState;
      setState(j);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runFullScan() {
    setScanning(true);
    setScanMessage("Scanning your book… this may take a minute.");
    try {
      const r = await fetch("/api/csm/gmail-labels/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        scanned?: number;
        inferred?: number;
        skipped_pinned?: number;
        no_history?: number;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setScanMessage(
        `Scan complete — ${j.inferred ?? 0} new labels inferred · ${
          j.skipped_pinned ?? 0
        } manual overrides preserved · ${j.no_history ?? 0} with no Gmail history.`
      );
      await refresh();
    } catch (e) {
      setScanMessage(
        `Scan failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setScanning(false);
    }
  }

  async function setRowLabel(
    workspaceId: string,
    labelId: string | null,
    labelName: string | null
  ): Promise<void> {
    setRowBusy(workspaceId);
    try {
      const r = await fetch("/api/csm/gmail-labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          labelId
            ? {
                workspace_id: workspaceId,
                label_id: labelId,
                label_name: labelName,
                action: "set",
              }
            : {
                workspace_id: workspaceId,
                action: "clear",
              }
        ),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        row?: CustomerLabelRow;
        error?: string;
      };
      if (!r.ok || !j.ok || !j.row) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      // Merge the returned row into local state so the UI reflects the
      // write without a round-trip refresh.
      setState((prev) => ({
        ...prev,
        mapping: { ...prev.mapping, [workspaceId]: j.row! },
      }));
    } catch (e) {
      setScanMessage(
        `Save failed for ${workspaceId}: ${
          e instanceof Error ? e.message : "unknown"
        }`
      );
    } finally {
      setRowBusy(null);
    }
  }

  async function rescanRow(workspaceId: string): Promise<void> {
    setRowBusy(workspaceId);
    try {
      const r = await fetch(
        `/api/csm/gmail-labels/scan/${encodeURIComponent(workspaceId)}`,
        { method: "POST" }
      );
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        inferred?: { label_id: string; label_name: string } | null;
        reason?: string;
        error?: string;
        existing?: CustomerLabelRow;
      };
      if (r.status === 409) {
        setScanMessage(j.error ?? "Row is pinned — reset it first.");
        return;
      }
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      if (j.inferred) {
        const next: CustomerLabelRow = {
          label_id: j.inferred.label_id,
          label_name: j.inferred.label_name,
          source: "inferred",
          inferred_at: new Date().toISOString(),
        };
        setState((prev) => ({
          ...prev,
          mapping: { ...prev.mapping, [workspaceId]: next },
        }));
      } else {
        setScanMessage(
          j.reason ? `No label inferred (${j.reason}).` : "No label inferred."
        );
        // Drop the existing row from local view if it was "inferred"
        // but no longer meets the bar.
        setState((prev) => {
          if (!prev.mapping[workspaceId]) return prev;
          if (prev.mapping[workspaceId].source !== "inferred") return prev;
          const next = { ...prev.mapping };
          delete next[workspaceId];
          return { ...prev, mapping: next };
        });
      }
    } catch (e) {
      setScanMessage(
        `Rescan failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setRowBusy(null);
    }
  }

  const labelsById = useMemo(
    () => new Map(state.labels.map((l) => [l.id, l])),
    [state.labels]
  );

  const filteredCustomers = useMemo(() => {
    if (!search.trim()) return customers;
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      return (
        (c.company_name ?? "").toLowerCase().includes(q) ||
        (c.workspace_name ?? "").toLowerCase().includes(q) ||
        (c.owner_email ?? "").toLowerCase().includes(q)
      );
    });
  }, [customers, search]);

  const mappedCount = useMemo(() => {
    let n = 0;
    for (const c of customers) {
      const row = state.mapping[c.workspace_id];
      if (row && row.source !== "cleared" && row.label_id) n++;
    }
    return n;
  }, [customers, state.mapping]);

  const needsReconsent =
    !state.has_modify_scope ||
    (Boolean(state.labels_error) && state.labels.length === 0);

  return (
    <div className="space-y-4">
      {needsReconsent ? (
        <div className="rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
          <strong>Re-grant Gmail access.</strong> We just added the{" "}
          <code className="font-mono text-xs">gmail.modify</code> scope so the
          dashboard can list your labels and attach them to drafts.{" "}
          <a
            href="/api/auth/google/start"
            className="underline font-medium"
          >
            Re-connect Google
          </a>{" "}
          and reload this page. ({state.labels_error})
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button
          type="button"
          onClick={runFullScan}
          disabled={scanning || needsReconsent}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "↻ Re-scan my whole book"}
        </button>
        <span className="text-muted">
          {mappedCount} of {customers.length} mapped
          {state.last_full_scan ? (
            <>
              {" · last scan "}
              {new Date(state.last_full_scan).toLocaleString()}
            </>
          ) : null}
        </span>
        <input
          type="text"
          placeholder="Search customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg min-w-[180px]"
        />
      </div>

      {scanMessage ? (
        <div className="text-xs text-muted bg-canvas/40 border border-border rounded-md px-3 py-2">
          {scanMessage}
        </div>
      ) : null}
      {loadError ? (
        <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md px-3 py-2">
          Couldn&rsquo;t load mapping: {loadError}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted">Loading mapping…</p>
      ) : filteredCustomers.length === 0 ? (
        <p className="text-sm text-muted">
          {search ? "No customers match your search." : "No customers in your book."}
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg overflow-hidden">
          {filteredCustomers.map((c) => {
            const row = state.mapping[c.workspace_id];
            const isBusy = rowBusy === c.workspace_id;
            const live = row?.source !== "cleared" && row?.label_id;
            const label = live ? labelsById.get(row!.label_id!) : null;
            return (
              <li
                key={c.workspace_id}
                className="px-3 py-2 flex flex-wrap items-center gap-3 text-sm bg-surface"
              >
                <div className="flex-1 min-w-[200px]">
                  <div className="font-medium text-fg break-words">
                    {c.company_name ?? c.workspace_name ?? c.workspace_id}
                  </div>
                  <div className="text-[11px] text-muted">
                    {c.owner_email ?? "(no owner email)"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={row?.label_id ?? ""}
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) {
                        void setRowLabel(c.workspace_id, null, null);
                        return;
                      }
                      const picked = labelsById.get(id);
                      void setRowLabel(
                        c.workspace_id,
                        id,
                        picked?.name ?? null
                      );
                    }}
                    disabled={isBusy || needsReconsent}
                    className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg min-w-[200px] disabled:opacity-50"
                  >
                    <option value="">
                      {row?.source === "cleared"
                        ? "— cleared —"
                        : row?.source === "inferred"
                        ? "(detected) " + (row.label_name ?? "")
                        : "— no label —"}
                    </option>
                    {state.labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  {row?.source === "inferred" ? (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded border bg-canvas/40 text-muted border-border"
                      title="Auto-detected — future scans may overwrite this. Pick a label manually to pin it."
                    >
                      auto
                    </span>
                  ) : null}
                  {row?.source === "manual" ? (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded border bg-accent/10 text-accent-fg border-accent/30"
                      title="Manual override — pinned across scans."
                    >
                      manual
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void rescanRow(c.workspace_id)}
                    disabled={isBusy || needsReconsent || row?.source === "manual" || row?.source === "cleared"}
                    className="text-[11px] text-muted hover:text-fg disabled:opacity-30"
                    title={
                      row?.source === "manual" || row?.source === "cleared"
                        ? "Reset the manual override first"
                        : "Re-scan this customer's Gmail history"
                    }
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    onClick={() => void setRowLabel(c.workspace_id, null, null)}
                    disabled={isBusy || row?.source === "cleared"}
                    className="text-[11px] text-muted hover:text-red-700 disabled:opacity-30"
                    title="Don't apply any label to drafts for this customer"
                  >
                    Clear
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
