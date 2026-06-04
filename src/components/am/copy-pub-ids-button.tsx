"use client";

import { useState } from "react";
import { fetchPublicationsForWorkspace } from "@/lib/hooks/customer-publications-cache";

/**
 * Bulk-action button that gathers every publication ID owned by the
 * selected workspaces and writes them to the clipboard as a
 * comma-separated list. Used on the Proactive Outreach panels so a
 * CSM can grab a clipboard-ready list to paste into Metabase / Stripe
 * metadata / a Slack message without expanding each row.
 *
 * Source of truth is `/api/customers/[workspace_id]/publications`,
 * the same endpoint the expanded company view uses. Fetched on click
 * via the shared `customer-publications-cache` module so:
 *
 *   - Already-expanded rows hit cache instantly.
 *   - Repeat clicks on the same selection are free.
 *   - We sidestep Metabase's 2000-row /api/dataset cap that truncates
 *     the global publications-index.
 *
 * Concurrency is capped (~6 parallel) so a 30-row selection doesn't
 * fan out 30 simultaneous Metabase queries.
 */

interface Props {
  /** Workspace IDs the user has selected. */
  workspaceIds: string[];
  /** Disable when the parent's selection state would produce zero
   *  output. Convenience for the toolbar — the button is no-op even
   *  if pressed, but disabling matches the other bulk-action buttons. */
  disabled?: boolean;
}

type Format = "prefixed" | "raw";

interface CopyResult {
  format: Format;
  text: string;
  pubCount: number;
  workspaceTotal: number;
  workspacesWithPubs: number;
  workspaceErrors: number;
  error: string | null;
}

/** Strip any `pub_` prefix and emit the requested format. Input may
 *  be a mix of raw UUIDs and prefixed forms (the publications endpoint
 *  returns raw `id::text`, but historical data sometimes leaks the
 *  prefix); we canonicalize before deduping so each publication
 *  contributes one entry regardless of source format. */
function uniquePubs(ids: string[], format: Format): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of ids) {
    const raw = id.startsWith("pub_") ? id.slice(4) : id;
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    order.push(raw);
  }
  if (format === "raw") return order;
  return order.map((r) => `pub_${r}`);
}

/** Run `task` over `items` with at most `limit` concurrent in flight.
 *  Resolves to results in input order. A task that throws fills its
 *  slot with the rejection; the caller decides how to fold it. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<
    { ok: true; value: R } | { ok: false; error: unknown }
  > = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await task(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

export function CopyPubIdsButton({ workspaceIds, disabled }: Props) {
  const [result, setResult] = useState<CopyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );

  async function copy(format: Format) {
    if (workspaceIds.length === 0) {
      setResult({
        format,
        text: "",
        pubCount: 0,
        workspaceTotal: 0,
        workspacesWithPubs: 0,
        workspaceErrors: 0,
        error: "Select rows first.",
      });
      return;
    }

    setBusy(true);
    setResult(null);
    setProgress({ done: 0, total: workspaceIds.length });

    // Concurrency cap of 6: the per-workspace endpoint typically returns
    // in ~150-400ms; six parallel keeps Metabase comfortable while
    // finishing a 30-workspace selection in ~2s worst case.
    let done = 0;
    const outcomes = await mapConcurrent(workspaceIds, 6, async (ws) => {
      const pubs = await fetchPublicationsForWorkspace(ws);
      done++;
      setProgress({ done, total: workspaceIds.length });
      return pubs.map((p) => p.publication_id);
    });

    setBusy(false);
    setProgress(null);

    let workspacesWithPubs = 0;
    let workspaceErrors = 0;
    const allIds: string[] = [];
    for (const o of outcomes) {
      if (!o.ok) {
        workspaceErrors++;
        continue;
      }
      if (o.value.length === 0) continue;
      workspacesWithPubs++;
      allIds.push(...o.value);
    }

    const ids = uniquePubs(allIds, format);
    const text = ids.join(", ");

    if (ids.length === 0) {
      setResult({
        format,
        text: "",
        pubCount: 0,
        workspaceTotal: workspaceIds.length,
        workspacesWithPubs,
        workspaceErrors,
        error:
          workspaceErrors === workspaceIds.length
            ? "Every per-workspace fetch failed. Check the network tab and Metabase availability."
            : "None of the selected workspaces have publications.",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setResult({
        format,
        text,
        pubCount: ids.length,
        workspaceTotal: workspaceIds.length,
        workspacesWithPubs,
        workspaceErrors,
        error: null,
      });
    } catch (e) {
      setResult({
        format,
        text,
        pubCount: ids.length,
        workspaceTotal: workspaceIds.length,
        workspacesWithPubs,
        workspaceErrors,
        error: `Clipboard write failed: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      });
    }
  }

  const isDisabled = disabled || workspaceIds.length === 0 || busy;
  const skippedNoPubs =
    result && !result.error
      ? result.workspaceTotal - result.workspacesWithPubs - result.workspaceErrors
      : 0;

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-stretch gap-0">
        <button
          type="button"
          onClick={() => void copy("prefixed")}
          disabled={isDisabled}
          className="px-2 py-1 text-xs border border-border-strong rounded-l-md bg-surface hover:bg-canvas disabled:opacity-50"
          title={
            workspaceIds.length === 0
              ? "Select rows first to copy their publication IDs."
              : `Copy pub_<uuid> form for the ${workspaceIds.length} selected workspace${workspaceIds.length === 1 ? "" : "s"}.`
          }
        >
          {busy && progress
            ? `Fetching… ${progress.done}/${progress.total}`
            : `📋 Copy pub IDs${workspaceIds.length > 0 ? ` (${workspaceIds.length})` : ""}`}
        </button>
        <button
          type="button"
          onClick={() => void copy("raw")}
          disabled={isDisabled}
          className="px-2 py-1 text-xs border-y border-r border-border-strong rounded-r-md bg-surface hover:bg-canvas disabled:opacity-50"
          title="Copy raw UUIDs (no pub_ prefix) — for SQL/Metabase IN-clauses."
        >
          raw
        </button>
      </span>
      {result ? (
        <div
          className={`text-[11px] rounded-md border p-2 max-w-md ${
            result.error
              ? "border-red-300 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300"
              : "border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
          }`}
        >
          {result.error ? (
            <div>{result.error}</div>
          ) : (
            <div className="flex flex-col gap-1">
              <div>
                Copied <strong>{result.pubCount}</strong> publication ID
                {result.pubCount === 1 ? "" : "s"} from{" "}
                <strong>{result.workspacesWithPubs}</strong> /{" "}
                {result.workspaceTotal} selected workspace
                {result.workspaceTotal === 1 ? "" : "s"} (
                {result.format === "prefixed" ? "pub_ form" : "raw UUIDs"}).
              </div>
              {skippedNoPubs > 0 ? (
                <div className="text-amber-700 dark:text-amber-300">
                  {skippedNoPubs} workspace
                  {skippedNoPubs === 1 ? "" : "s"} had no publications.
                </div>
              ) : null}
              {result.workspaceErrors > 0 ? (
                <div className="text-amber-700 dark:text-amber-300">
                  {result.workspaceErrors} per-workspace fetch
                  {result.workspaceErrors === 1 ? "" : "es"} failed (Metabase /
                  network).
                </div>
              ) : null}
              <details className="mt-1">
                <summary className="cursor-pointer select-none">
                  Show clipboard contents
                </summary>
                <textarea
                  readOnly
                  className="mt-1 w-full text-[11px] font-mono p-1 border border-emerald-300 rounded bg-white dark:bg-canvas"
                  rows={Math.min(6, Math.max(2, Math.ceil(result.pubCount / 4)))}
                  value={result.text}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </details>
            </div>
          )}
          <button
            type="button"
            onClick={() => setResult(null)}
            className="mt-1 text-[10px] underline opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </span>
  );
}
