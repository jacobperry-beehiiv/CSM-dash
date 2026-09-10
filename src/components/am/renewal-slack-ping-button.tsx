"use client";

import { useState } from "react";

/**
 * "📣 Slack" button that fires the manual renewal-kickoff / thread-
 * ping flow for one or many workspaces. Row-level buttons render
 * with a single-element array; the bulk selection toolbar passes
 * everything currently checked. Endpoint handles both shapes.
 *
 * If a pricing thread already exists for a workspace, the endpoint
 * posts a lightweight ping reply into that thread. If not, it posts
 * the same kickoff-message format the milestone engine uses as a
 * new parent and saves the thread record so the next auto-milestone
 * or manual ping reuses it.
 */

interface PingResult {
  workspace_id: string;
  workspace_name: string | null;
  thread_created: boolean;
  thread_ts: string | null;
  error?: string;
}

interface PingResponse {
  ok?: boolean;
  total?: number;
  sent?: number;
  failed?: number;
  results?: PingResult[];
  error?: string;
}

interface Props {
  workspaceIds: string[];
  /** Row-level button ("📣 Slack"), bulk button
   *  ("📣 Slack ping N selected"), or a caller-provided override. */
  label?: string;
  /** Compact styling for a table row (smaller padding + no
   *  wrap-around toast). Bulk toolbar uses the default. */
  compact?: boolean;
  /** Optional callback fired after each successful/failed ping —
   *  the panel uses this to refresh row state or flash a per-row
   *  indicator. Passed the raw response so callers can decide what
   *  to do (e.g. only update on `.sent > 0`). */
  onDone?: (res: PingResponse) => void;
}

export function RenewalSlackPingButton({
  workspaceIds,
  label,
  compact = false,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = workspaceIds.length === 0;
  const n = workspaceIds.length;
  const computedLabel =
    label ??
    (n <= 1 ? "📣 Slack" : `📣 Slack ping ${n} selected`);

  async function fire() {
    if (disabled) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const r = await fetch("/api/renewals/kickoff-slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_ids: workspaceIds }),
      });
      const j = (await r.json()) as PingResponse;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const sent = j.sent ?? 0;
      const failed = j.failed ?? 0;
      const created =
        j.results?.filter((x) => x.thread_created).length ?? 0;
      const bits = [`${sent} posted`];
      if (created > 0) bits.push(`${created} new thread${created === 1 ? "" : "s"}`);
      if (failed > 0) bits.push(`${failed} failed`);
      setMessage(bits.join(", "));
      onDone?.(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
      // Clear the toast after a beat so it doesn't sit in the row
      // forever. Bulk toolbar can afford a longer hold since it's
      // the summary of a batch action.
      setTimeout(
        () => {
          setMessage(null);
          setError(null);
        },
        compact ? 5_000 : 10_000
      );
    }
  }

  const btnClass = compact
    ? "px-2 py-0.5 text-[11px] border border-border-strong rounded bg-surface hover:bg-canvas disabled:opacity-50"
    : "px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50";

  return (
    <span className={compact ? "inline-flex items-center gap-1.5" : "inline-flex flex-col gap-1"}>
      <button
        type="button"
        onClick={() => void fire()}
        disabled={busy || disabled}
        className={btnClass}
        title={
          n <= 1
            ? "Post a kickoff message in the renewals channel — or, if a pricing thread already exists for this account, reply in that thread."
            : "For each selected row, post a kickoff message or reply in the existing pricing thread."
        }
      >
        {busy ? "Sending…" : computedLabel}
      </button>
      {message ? (
        <span
          className={
            compact
              ? "text-[10px] text-emerald-700 dark:text-emerald-300"
              : "text-[10px] text-emerald-700 dark:text-emerald-300"
          }
        >
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
