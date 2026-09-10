"use client";

import { useMemo, useState } from "react";

/**
 * Client editor for the /settings/access allowlist. Local rows
 * with `dirty` tracking, PUT to the API on Save, echoes back the
 * server-sanitized list so any dropped rows (bad email shape,
 * duplicates) surface immediately.
 *
 * Mirrors the shape of the merge-tags editor — one row per email,
 * remove buttons per row, Add-row at the bottom, Save/Reset when
 * the local list diverges from the saved one.
 */

interface Row {
  value: string;
}

function toRows(list: string[]): Row[] {
  return list.map((value) => ({ value }));
}

function rowsEqual(a: Row[], b: Row[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].value !== b[i].value) return false;
  }
  return true;
}

interface Props {
  initial: string[];
}

export function AccessAllowlistEditor({ initial }: Props) {
  const [rows, setRows] = useState<Row[]>(() => toRows(initial));
  const [saved, setSaved] = useState<Row[]>(() => toRows(initial));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => !rowsEqual(rows, saved), [rows, saved]);

  function updateRow(idx: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { value } : r)));
    setMessage(null);
  }
  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    setMessage(null);
  }
  function addRow() {
    setRows((prev) => [...prev, { value: "" }]);
    setMessage(null);
  }
  function reset() {
    setRows(saved);
    setMessage(null);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = {
        extra_csm_emails: rows.map((r) => r.value),
      };
      const r = await fetch("/api/settings/access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        extra_csm_emails?: string[];
        dropped?: number;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const next = toRows(j.extra_csm_emails ?? []);
      setRows(next);
      setSaved(next);
      const dropped = j.dropped ?? 0;
      setMessage(
        dropped > 0
          ? `Saved. ${dropped} entr${dropped === 1 ? "y" : "ies"} dropped by validation (bad email shape or duplicate).`
          : "Saved."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl space-y-3">
      <div className="rounded-md border border-border bg-surface p-3 space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs italic text-muted">
            No extra emails on the allowlist. Add one below.
          </p>
        ) : (
          rows.map((r, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="email"
                value={r.value}
                onChange={(e) => updateRow(idx, e.target.value)}
                placeholder="someone@beehiiv.com"
                className="flex-1 text-sm px-2 py-1 rounded border border-border bg-canvas"
              />
              <button
                type="button"
                onClick={() => removeRow(idx)}
                className="text-xs text-red-600 dark:text-red-400 hover:underline"
                title="Remove row"
              >
                Remove
              </button>
            </div>
          ))
        )}
        <button
          type="button"
          onClick={addRow}
          className="text-xs text-accent hover:underline"
        >
          + Add email
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="px-4 py-2 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy || !dirty}
          className="px-3 py-2 rounded border border-border-strong text-sm hover:bg-canvas disabled:opacity-50"
        >
          Reset
        </button>
        {message ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {message}
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-red-700 dark:text-red-300">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
