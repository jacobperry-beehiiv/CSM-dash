"use client";

import { useState } from "react";
import type { ReviewWorkflow } from "@/lib/data/review-states-types";

/**
 * Shared "📣 Send digest" button — placed on each AM panel's toolbar
 * so admins can fire the per-CSM review digest on demand outside the
 * daily cron cadence. The button can scope to a single workflow
 * (panel-specific) or send the cross-workflow digest (left unspecified).
 *
 * Wire-up:
 *   POST /api/review-digest/sweep with { dry_run?, workflows? }
 *
 * Surfaces the result inline — message count, failures, and the
 * "no_channel_configured" hint pointing at /settings/slack. The
 * button stays disabled while the request is in flight so a
 * double-click can't fire two digests in parallel.
 */

interface Props {
  /** When omitted the button fires the full multi-workflow digest. */
  workflows?: ReviewWorkflow[];
  /** Override the default button label. */
  label?: string;
  className?: string;
}

interface SweepResponse {
  ok?: boolean;
  error?: string;
  messages_sent?: number;
  messages_failed?: number;
  per_csm?: Array<{ csm: string; total: number }>;
  failures?: Array<{ csm: string; error: string }>;
  no_channel_configured?: boolean;
  triggered_by?: string;
}

export function SendDigestButton({
  workflows,
  label,
  className,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const r = await fetch("/api/review-digest/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflows: workflows ?? undefined,
        }),
      });
      const j = (await r.json()) as SweepResponse;
      if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      if (j.no_channel_configured) {
        setError(
          "No digest channel configured — set the Slack channel ID at /settings/slack → Per-CSM review digest."
        );
        return;
      }
      const sent = j.messages_sent ?? 0;
      const failed = j.messages_failed ?? 0;
      const recipients = (j.per_csm ?? []).length;
      const bits = [
        `Digest sent — ${sent} CSM${sent === 1 ? "" : "s"} pinged`,
      ];
      if (failed > 0) bits.push(`${failed} failed`);
      if (recipients > sent + failed) {
        bits.push(`${recipients - sent - failed} skipped (no work)`);
      }
      setMessage(`${bits.join(", ")}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
      // Clear the message after a beat so it doesn't linger forever.
      setTimeout(() => {
        setMessage(null);
        setError(null);
      }, 10_000);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void send()}
        disabled={busy}
        className={`px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50 ${className ?? ""}`}
        title={
          workflows && workflows.length > 0
            ? `Send the ${workflows.join(" + ")} digest now (outside the daily cron). One Slack message per CSM with non-zero counts.`
            : "Send the full per-CSM digest now (past-due + proactive + renewals)."
        }
      >
        {busy ? "Sending…" : label ?? "📣 Send digest"}
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
