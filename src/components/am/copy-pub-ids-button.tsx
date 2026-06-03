"use client";

import { useState } from "react";

/**
 * Bulk-action button that gathers every publication ID owned by the
 * selected workspaces and writes them to the clipboard as a
 * comma-separated list. Used on the Proactive Outreach panels so a
 * CSM can grab a clipboard-ready list to paste into Metabase / Stripe
 * metadata / a Slack message without expanding each row.
 *
 * Source of truth is the publications index (ws2pubs) — the same map
 * that drives publication-ID search. Each workspace contributes ALL
 * of its publications, not one. The toast surfaces the exact text
 * that landed on the clipboard so the user can verify nothing got
 * truncated client-side.
 */

interface Props {
  /** Workspace IDs the user has selected. The button looks each up
   *  in ws2pubs to produce the final pub-ID list. */
  workspaceIds: string[];
  /** Reverse map: workspace_id → publication_id[] — passed in by the
   *  parent panel which already loads it via usePublicationsIndex.
   *  Note: usePublicationsIndex stores BOTH the raw UUID and the
   *  customer-facing `pub_<uuid>` form in this array, so we have to
   *  dedupe per-publication before emitting. */
  ws2pubs: Record<string, string[]>;
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
  error: string | null;
}

/** Normalize a list of mixed raw + `pub_`-prefixed IDs to one unique
 *  entry per publication. The publications-index hook doubles each
 *  pub (raw + prefixed) so substring search hits either form, but
 *  for export we want one ID per publication.
 *
 *  Returns the requested format. When `prefixed` is asked for we
 *  ensure every ID starts with `pub_`; when `raw` is asked for we
 *  strip the prefix if present.
 */
function uniquePubs(list: string[], format: Format): string[] {
  // Canonicalize: strip any pub_ prefix, dedupe at the raw-UUID level.
  // That collapses the [raw, "pub_"+raw] doubling regardless of which
  // form happens to come first.
  const rawSet = new Set<string>();
  const order: string[] = [];
  for (const id of list) {
    const raw = id.startsWith("pub_") ? id.slice(4) : id;
    if (!raw) continue;
    if (rawSet.has(raw)) continue;
    rawSet.add(raw);
    order.push(raw);
  }
  if (format === "raw") return order;
  return order.map((r) => `pub_${r}`);
}

export function CopyPubIdsButton({ workspaceIds, ws2pubs, disabled }: Props) {
  const [result, setResult] = useState<CopyResult | null>(null);

  async function copy(format: Format) {
    const all: string[] = [];
    let workspacesWithPubs = 0;
    for (const ws of workspaceIds) {
      const list = ws2pubs[ws];
      if (!list || list.length === 0) continue;
      workspacesWithPubs++;
      all.push(...list);
    }
    const ids = uniquePubs(all, format);
    const text = ids.join(", ");

    if (ids.length === 0) {
      setResult({
        format,
        text: "",
        pubCount: 0,
        workspaceTotal: workspaceIds.length,
        workspacesWithPubs,
        error:
          workspaceIds.length === 0
            ? "Select rows first."
            : "None of the selected workspaces have publications in the index.",
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
        error: null,
      });
    } catch (e) {
      setResult({
        format,
        text,
        pubCount: ids.length,
        workspaceTotal: workspaceIds.length,
        workspacesWithPubs,
        error: `Clipboard write failed: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      });
    }
  }

  const isDisabled = disabled || workspaceIds.length === 0;

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
          📋 Copy pub IDs
          {workspaceIds.length > 0 ? ` (${workspaceIds.length})` : ""}
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
              {result.workspacesWithPubs < result.workspaceTotal ? (
                <div className="text-amber-700 dark:text-amber-300">
                  {result.workspaceTotal - result.workspacesWithPubs} workspace
                  {result.workspaceTotal - result.workspacesWithPubs === 1
                    ? ""
                    : "s"}{" "}
                  had no publications in the index (deleted, brand-new, or
                  ID mismatch).
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
