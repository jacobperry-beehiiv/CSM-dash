"use client";

import { useState } from "react";

/**
 * Shared bulk-Slack compose modal for the AM dashboard. Both Past Due
 * and Approaching Enterprise route their "Slack the channel" action
 * through this component.
 *
 * Two send modes:
 *
 *   • Combined — one Slack message that lists every selected account
 *     inline. Same shape we've always had on Past Due; good when the
 *     audience is one channel reading a digest.
 *
 *   • Per company — one Slack message per selected row, fired
 *     sequentially against the same channel. Each lands as its own
 *     top-level message so replies thread per company. That's the
 *     mode CSMs want when they need someone to triage each account
 *     individually.
 *
 * Callers pre-render the bodies (so the row-template / token logic
 * stays close to the row data) and pass them in. The modal owns
 * channel input, mode toggle, editable bodies, and the send loop.
 */

export interface BulkSlackMessage {
  /** React key + dedupe key. Usually the row's stable id. */
  id: string;
  /** Short header shown above each editable textarea in per-company
   *  mode ("Account: foo@bar.com" / "Workspace: Blah"). */
  label: string;
  /** Initial Slack-mrkdwn body for this row's message. */
  text: string;
}

interface Props {
  /** Display heading at the top of the modal. */
  title: string;
  /** Pre-rendered combined message (channel template with
   *  `{{account_list}}` already substituted). */
  initialCombinedText: string;
  /** One pre-rendered per-row message per selected row. */
  perCompanyMessages: BulkSlackMessage[];
  /** Channel ID prefilled from settings (`/settings/slack`). */
  initialChannel: string;
  /** What mode to default to when the modal opens. Per-company is
   *  the better default for threaded triage; pass "combined" for
   *  digest-style channels. */
  defaultMode?: "combined" | "per-company";
  onClose: () => void;
}

type Mode = "combined" | "per-company";

export function SlackBulkCompose({
  title,
  initialCombinedText,
  perCompanyMessages,
  initialChannel,
  defaultMode = "per-company",
  onClose,
}: Props) {
  const [channel, setChannel] = useState(initialChannel);
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [combined, setCombined] = useState(initialCombinedText);
  const [perMessages, setPerMessages] = useState(perCompanyMessages);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function patchMessage(id: string, text: string) {
    setPerMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, text } : m))
    );
  }

  async function postOne(text: string): Promise<void> {
    const r = await fetch("/api/slack-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, text }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `HTTP ${r.status}`);
    }
  }

  async function send() {
    if (!channel) {
      setError("Pick a channel before sending.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (mode === "combined") {
        await postOne(combined);
        setResult("Sent combined message ✓");
      } else {
        // Fire sequentially so a per-message failure surfaces against
        // the specific row that failed, and we don't slam Slack's
        // rate limit with a parallel burst.
        const fails: string[] = [];
        let succeeded = 0;
        for (const m of perMessages) {
          if (!m.text.trim()) continue;
          try {
            await postOne(m.text);
            succeeded++;
          } catch (e) {
            fails.push(
              `${m.label} (${e instanceof Error ? e.message : "unknown"})`
            );
          }
        }
        const note =
          fails.length > 0 ? ` · failed: ${fails.join("; ")}` : "";
        setResult(
          `Sent ${succeeded}/${perMessages.length} per-company message${
            perMessages.length === 1 ? "" : "s"
          } ✓${note}`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  const sendDisabled =
    busy ||
    !channel ||
    (mode === "combined"
      ? !combined.trim()
      : perMessages.every((m) => !m.text.trim()));

  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h3 className="font-semibold text-fg">{title}</h3>
            <p className="text-xs text-muted mt-0.5">
              {perMessages.length} account
              {perMessages.length === 1 ? "" : "s"} selected
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="text-xs text-muted block mb-1">
              Channel ID (e.g. C0AMK142WUR)
            </label>
            <input
              type="text"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="C0AMK142WUR"
              className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
            />
          </div>

          <div>
            <p className="text-xs text-muted mb-1">Mode</p>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
              <button
                onClick={() => setMode("per-company")}
                className={`px-3 py-1.5 ${
                  mode === "per-company"
                    ? "bg-accent text-accent-fg font-medium"
                    : "bg-surface text-muted hover:text-fg"
                }`}
              >
                Per company ({perMessages.length})
              </button>
              <button
                onClick={() => setMode("combined")}
                className={`px-3 py-1.5 border-l border-border ${
                  mode === "combined"
                    ? "bg-accent text-accent-fg font-medium"
                    : "bg-surface text-muted hover:text-fg"
                }`}
              >
                Combined (1)
              </button>
            </div>
            <p className="text-[11px] text-muted mt-1">
              Per company sends one Slack message per row so replies thread
              against the right account. Combined sends a single digest.
            </p>
          </div>

          {mode === "combined" ? (
            <div>
              <label className="text-xs text-muted block mb-1">Message</label>
              <textarea
                value={combined}
                onChange={(e) => setCombined(e.target.value)}
                rows={14}
                className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
              />
            </div>
          ) : (
            <div className="space-y-3">
              {perMessages.map((m) => (
                <div key={m.id}>
                  <label className="text-xs text-muted block mb-1">
                    {m.label}
                  </label>
                  <textarea
                    value={m.text}
                    onChange={(e) => patchMessage(m.id, e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
                  />
                </div>
              ))}
              {perMessages.length === 0 ? (
                <p className="text-sm text-subtle italic">
                  No rows selected.
                </p>
              ) : null}
            </div>
          )}

          {error ? (
            <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
              {error}
            </div>
          ) : null}
          {result ? (
            <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-md p-3 text-sm text-emerald-800 dark:text-emerald-300">
              {result}
            </div>
          ) : null}
        </div>

        <div className="p-4 border-t border-border flex items-center gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sendDisabled}
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {busy
              ? "Sending…"
              : mode === "combined"
                ? "Send 1 message"
                : `Send ${perMessages.length} message${
                    perMessages.length === 1 ? "" : "s"
                  }`}
          </button>
        </div>
      </div>
    </div>
  );
}
