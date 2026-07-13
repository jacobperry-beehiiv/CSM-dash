"use client";

import { useEffect, useState } from "react";
import { MigrationWarmupResult } from "./migration-warmup-result";
import type {
  ListInput,
  MigrationPlan,
} from "@/lib/engines/migration-warmup/types";

/**
 * Client form for /csm/migration-warmup.
 *
 * State model:
 *  - Folder picker fetches once on mount via GET /folders. Two
 *    non-happy paths it must handle: 403 ineligible (gated higher
 *    up, but defense in depth), and 200 + `scope_missing` — in
 *    which case the picker hides and the manual-URL field takes
 *    over.
 *  - List rows are mutable (add / remove / edit). One blank row
 *    starts.
 *  - Submit POSTs the whole thing to /api/csm/migration-warmup;
 *    server runs the engine + creates the Sheet + populates it.
 *    The response carries the plan JSON (for inline render) + the
 *    sheet URL (the prominent "Open in Google Sheets" CTA).
 */

interface FolderOption {
  id: string;
  name: string;
  webViewLink: string;
}

type ListRow = {
  name: string;
  subscribers: string;
  cadence: string;
  open_rate: string;
  deadline_weeks: string;
  deliverability_concern: boolean;
};

const EMPTY_ROW: ListRow = {
  name: "",
  subscribers: "",
  cadence: "daily",
  open_rate: "",
  deadline_weeks: "",
  deliverability_concern: false,
};

const CADENCE_OPTIONS = [
  "daily",
  "5x/week",
  "4x/week",
  "3x/week",
  "2x/week",
  "1x/week",
  "bi-weekly",
  "monthly",
  "irregular",
];

export function MigrationWarmupForm() {
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [folderQuery, setFolderQuery] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<FolderOption | null>(
    null
  );
  const [manualFolderUrl, setManualFolderUrl] = useState("");
  const [manualCustomerName, setManualCustomerName] = useState("");
  const [scopeMissing, setScopeMissing] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(true);

  const [structure, setStructure] = useState<"separate" | "nls">("separate");
  const [rows, setRows] = useState<ListRow[]>([EMPTY_ROW]);
  // Warmup start date — used by the result page to compute progress
  // + projected end. Defaults to today's ISO date (UTC) so the CSM
  // gets "day 0 of N" out of the box; they can back-date it if the
  // ramp has already been in flight.
  const [warmupStartDate, setWarmupStartDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    | {
        sheet: { id: string; name: string; webViewLink: string };
        plan: MigrationPlan;
        warmupStartDate: string;
      }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/csm/migration-warmup/folders", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as {
          folders?: FolderOption[];
          scope_missing?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (!r.ok) {
          setError(j.error ?? `HTTP ${r.status}`);
          return;
        }
        if (j.scope_missing) setScopeMissing(true);
        setFolders(j.folders ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoadingFolders(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredFolders =
    folderQuery.trim() === ""
      ? folders
      : folders.filter((f) =>
          f.name.toLowerCase().includes(folderQuery.toLowerCase())
        );

  function updateRow(i: number, patch: Partial<ListRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { ...EMPTY_ROW }]);
  }
  function removeRow(i: number) {
    setRows((prev) =>
      prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const lists: ListInput[] = rows
        .filter((r) => r.name.trim() && r.subscribers.trim())
        .map((r) => ({
          name: r.name.trim(),
          subscribers: r.subscribers.trim(),
          cadence: r.cadence,
          open_rate: r.open_rate.trim() === "" ? null : r.open_rate.trim(),
          deadline_weeks:
            r.deadline_weeks.trim() === ""
              ? null
              : Number(r.deadline_weeks),
          deliverability_concern: r.deliverability_concern,
        }));
      if (lists.length === 0) {
        throw new Error(
          "Add at least one list with both a name and a subscriber count."
        );
      }
      const body = {
        folder: selectedFolder,
        manual_folder_url: selectedFolder ? null : manualFolderUrl.trim(),
        manual_customer_name: selectedFolder ? null : manualCustomerName.trim(),
        structure,
        lists,
        warmup_start_date: warmupStartDate,
      };
      const r = await fetch("/api/csm/migration-warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as {
        sheet?: { id: string; name: string; webViewLink: string };
        plan?: MigrationPlan;
        warmup_start_date?: string;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (!j.sheet || !j.plan) throw new Error("Server returned no plan.");
      setResult({
        sheet: j.sheet,
        plan: j.plan,
        warmupStartDate: j.warmup_start_date ?? warmupStartDate,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    (selectedFolder !== null || manualFolderUrl.trim().length > 0) &&
    rows.some((r) => r.name.trim() && r.subscribers.trim());

  if (result) {
    return (
      <MigrationWarmupResult
        sheet={result.sheet}
        plan={result.plan}
        warmupStartDate={result.warmupStartDate}
        onReset={() => {
          setResult(null);
          setRows([EMPTY_ROW]);
        }}
      />
    );
  }

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-5">
      {/* Folder picker */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted">
          Customer (Drive folder)
        </label>
        {scopeMissing ? (
          <div className="rounded-md border border-border bg-canvas p-3 text-xs text-muted space-y-2">
            <p>
              Folder browsing needs the <code>drive.readonly</code> scope,
              which isn&rsquo;t granted on your Google connection yet.{" "}
              <a
                href="/settings/gmail"
                className="text-accent hover:underline"
              >
                Reconnect Google
              </a>{" "}
              to enable the picker, or paste a folder URL below.
            </p>
          </div>
        ) : loadingFolders ? (
          <div className="text-sm text-muted">Loading customer folders…</div>
        ) : selectedFolder ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-canvas px-3 py-2">
            <div className="text-sm">
              <span className="font-medium text-fg">{selectedFolder.name}</span>
              <a
                href={selectedFolder.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-xs text-accent hover:underline"
              >
                Open folder ↗
              </a>
            </div>
            <button
              type="button"
              onClick={() => setSelectedFolder(null)}
              className="text-xs text-muted hover:text-fg underline"
            >
              change
            </button>
          </div>
        ) : (
          <>
            <input
              type="text"
              value={folderQuery}
              onChange={(e) => setFolderQuery(e.target.value)}
              placeholder="Search customer folders…"
              className="w-full px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-canvas">
              {filteredFolders.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted">
                  No folders match.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {filteredFolders.slice(0, 50).map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedFolder(f);
                          setFolderQuery("");
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-surface focus:bg-surface focus:outline-none"
                      >
                        {f.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {!selectedFolder && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer hover:text-fg">
              Or paste a folder URL manually
            </summary>
            <div className="mt-2 space-y-2">
              <input
                type="text"
                value={manualFolderUrl}
                onChange={(e) => setManualFolderUrl(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/…"
                className="w-full px-3 py-2 text-xs bg-canvas border border-border rounded-md font-mono focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <input
                type="text"
                value={manualCustomerName}
                onChange={(e) => setManualCustomerName(e.target.value)}
                placeholder="Customer name (appears on the sheet)"
                className="w-full px-3 py-2 text-xs bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </details>
        )}
      </div>

      {/* Structure */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted">
          Plan structure
        </label>
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={structure === "separate"}
              onChange={() => setStructure("separate")}
            />
            <span>Separate sheet per list</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={structure === "nls"}
              onChange={() => setStructure("nls")}
            />
            <span>Combined (NLs by week)</span>
          </label>
        </div>
      </div>

      {/* Warmup start date — feeds the progress panel on the result
       *  page. Defaults to today; back-date it if the ramp is already
       *  underway. */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted">
          Warmup start date
        </label>
        <input
          type="date"
          value={warmupStartDate}
          onChange={(e) => setWarmupStartDate(e.target.value)}
          className="px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <p className="text-[11px] text-subtle">
          Determines where the customer is on their ramp today and the
          projected completion date. Defaults to today.
        </p>
      </div>

      {/* List rows */}
      <div className="space-y-3">
        <label className="block text-xs font-medium text-muted">Lists</label>
        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-canvas p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">List #{i + 1}</span>
              {rows.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="text-xs text-muted hover:text-red-600 underline"
                >
                  remove
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <Field label="Name">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => updateRow(i, { name: e.target.value })}
                  placeholder="Daily Brief"
                  className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
              <Field label="Subscribers">
                <input
                  type="text"
                  value={row.subscribers}
                  onChange={(e) =>
                    updateRow(i, { subscribers: e.target.value })
                  }
                  placeholder="150000 or 150k or ~150,000"
                  className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
              <Field label="Cadence">
                <select
                  value={row.cadence}
                  onChange={(e) => updateRow(i, { cadence: e.target.value })}
                  className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {CADENCE_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Open rate (optional)">
                <input
                  type="text"
                  value={row.open_rate}
                  onChange={(e) =>
                    updateRow(i, { open_rate: e.target.value })
                  }
                  placeholder="38% or 0.38 or blank"
                  className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
              <Field label="Deadline weeks (optional)">
                <input
                  type="number"
                  min={1}
                  value={row.deadline_weeks}
                  onChange={(e) =>
                    updateRow(i, { deadline_weeks: e.target.value })
                  }
                  placeholder=""
                  className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </Field>
              <Field label="Deliverability concern">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={row.deliverability_concern}
                    onChange={(e) =>
                      updateRow(i, {
                        deliverability_concern: e.target.checked,
                      })
                    }
                  />
                  <span>Force conservative pacing</span>
                </label>
              </Field>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas"
        >
          + Add another list
        </button>
      </div>

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="px-4 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate sheet"}
        </button>
        {error ? (
          <span className="text-xs text-red-700 dark:text-red-300">
            {error}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] font-medium text-muted">{label}</label>
      {children}
    </div>
  );
}
