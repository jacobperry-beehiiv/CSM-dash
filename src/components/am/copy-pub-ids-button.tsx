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
 * that drives publication-ID search. Workspaces with zero publications
 * (rare but possible: brand-new orgs) contribute nothing; the toast
 * surfaces the difference between selected workspaces and emitted
 * pub IDs so the user knows what got skipped.
 */

interface Props {
  /** Workspace IDs the user has selected. The button looks each up
   *  in ws2pubs to produce the final pub-ID list. */
  workspaceIds: string[];
  /** Reverse map: workspace_id → publication_id[] — passed in by the
   *  parent panel which already loads it via usePublicationsIndex. */
  ws2pubs: Record<string, string[]>;
  /** Disable when the parent's selection state would produce zero
   *  output. Convenience for the toolbar — the button is no-op even
   *  if pressed, but disabling matches the other bulk-action buttons. */
  disabled?: boolean;
}

export function CopyPubIdsButton({ workspaceIds, ws2pubs, disabled }: Props) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    const seen = new Set<string>();
    const pubs: string[] = [];
    let workspacesWithPubs = 0;
    for (const ws of workspaceIds) {
      const list = ws2pubs[ws];
      if (!list || list.length === 0) continue;
      workspacesWithPubs++;
      // ws2pubs stores BOTH the raw UUID and the customer-facing
      // "pub_<uuid>" form (see use-publications-index.ts). For
      // copy-to-clipboard the customer-facing form is friendlier —
      // it matches what they'd paste into Beehiiv admin URLs, the
      // public API, support threads.
      const prefixed = list.find((p) => p.startsWith("pub_"));
      const ids = prefixed
        ? list.filter((p) => p.startsWith("pub_"))
        : list;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        pubs.push(id);
      }
    }

    if (pubs.length === 0) {
      setError(
        workspaceIds.length === 0
          ? "Select rows first."
          : "None of the selected workspaces have publications in the index."
      );
      setTimeout(() => setError(null), 5000);
      return;
    }

    try {
      await navigator.clipboard.writeText(pubs.join(", "));
      const workspaceTail =
        workspacesWithPubs < workspaceIds.length
          ? ` (${workspaceIds.length - workspacesWithPubs} workspace${workspaceIds.length - workspacesWithPubs === 1 ? "" : "s"} had no pubs in the index)`
          : "";
      setMessage(
        `Copied ${pubs.length} publication ID${pubs.length === 1 ? "" : "s"}${workspaceTail}.`
      );
    } catch (e) {
      setError(
        `Clipboard write failed: ${
          e instanceof Error ? e.message : "unknown"
        }`
      );
    } finally {
      setTimeout(() => {
        setMessage(null);
        setError(null);
      }, 6000);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void copy()}
        disabled={disabled || workspaceIds.length === 0}
        className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
        title={
          workspaceIds.length === 0
            ? "Select rows first to copy their publication IDs."
            : `Copy publication IDs for the ${workspaceIds.length} selected workspace${workspaceIds.length === 1 ? "" : "s"} as a comma-separated list.`
        }
      >
        📋 Copy pub IDs
        {workspaceIds.length > 0 ? ` (${workspaceIds.length})` : ""}
      </button>
      {message ? (
        <span className="text-[10px] text-emerald-700 dark:text-emerald-300">
          {message}
        </span>
      ) : null}
      {error ? (
        <span className="text-[10px] text-red-700 dark:text-red-300">
          {error}
        </span>
      ) : null}
    </span>
  );
}
