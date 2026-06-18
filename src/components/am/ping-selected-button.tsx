"use client";

import { useState } from "react";
import type { ReviewWorkflow } from "@/lib/data/review-states-types";

/**
 * Shared "📣 Ping N selected on Slack" button for the AM tabs.
 *
 * Fires the per-CSM review digest scoped to the workspace_ids the
 * user has selected. The engine still groups by CSM, so a CSM with
 * 3 of the selected accounts gets a single ping with count=3, not
 * three separate messages. Each (CSM, workflow) lands in that
 * workflow's configured channel from /settings/slack.
 *
 * Replaces the older "Send Digest" button — that fired the full
 * cron-eligible cohort regardless of the user's selection. This is
 * the on-demand counterpart: blast just the rows the user picked.
 *
 * Renders nothing when nothing is selected; parents can slot it
 * unconditionally without juggling visibility themselves.
 */

interface SweepResponse {
  ok?: boolean;
  error?: string;
  messages_sent?: number;
  messages_failed?: number;
  per_csm?: Array<{ csm: string; total: number }>;
  failures?: Array<{ csm: string; error: string }>;
  no_channel_configured?: boolean;
}

export function PingSelectedButton({
  workspaceIds,
  workflow,
  label,
}: {
  workspaceIds: string[];
  workflow: ReviewWorkflow;
  /** Override the auto-generated button label. */
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = workspaceIds.length === 0;

  async function send() {
    if (disabled) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const r = await fetch("/api/review-digest/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflows: [workflow],
          workspace_ids: workspaceIds,
        }),
      });
      const j = (await r.json()) as SweepResponse;
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      if (j.no_channel_configured) {
        setError(
          "No channel configured for this workflow — set it at /settings/slack."
        );
        return;
      }
      const sent = j.messages_sent ?? 0;
      const failed = j.messages_failed ?? 0;
      const recipients = (j.per_csm ?? []).length;
      const bits = [`Ping sent — ${sent} CSM${sent === 1 ? "" : "s"}`];
      if (failed > 0) bits.push(`${failed} failed`);
      if (recipients > sent + failed) {
        bits.push(`${recipients - sent - failed} had no rows in selection`);
      }
      setMessage(`${bits.join(", ")}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
      // Clear the toast after a beat so it doesn't linger forever.
      setTimeout(() => {
        setMessage(null);
        setError(null);
      }, 10_000);
    }
  }

  const computedLabel =
    label ??
    `📣 Ping ${workspaceIds.length > 0 ? `${workspaceIds.length} ` : ""}selected on Slack`;

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void send()}
        disabled={busy || disabled}
        className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
        title="Post a per-CSM digest message in the configured Slack channel scoped to the selected rows. Each CSM with selected accounts gets one ping with their count."
      >
        {busy ? "Sending…" : computedLabel}
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
