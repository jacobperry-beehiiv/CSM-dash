"use client";

import { useState } from "react";
import {
  buildRollupTokens,
  DEFAULT_ROLLUP_TEMPLATE as SHARED_DEFAULT_TEMPLATE,
  renderRollupTemplate as renderRollupTemplateShared,
} from "@/lib/integrations/slack-rollup";

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
  /** Owning CSM's handle (snake_cased — matches
   *  Customer.customer_success_manager). Used by per-CSM rollup mode
   *  to group rows. Null for unassigned rows; they get bucketed into
   *  a single "Unassigned" group at the bottom of the per-CSM list. */
  csmHandle?: string | null;
  /** The CSM's Slack user_id (U…). Used to @-mention them in the
   *  per-CSM rolled-up message and to resolve the recipient when
   *  auto-creating their personal todo after send. Null → falls back
   *  to a plain-text "Jacob Perry" name in the message; the todo
   *  creation step also drops them with a logged warning. */
  csmSlackId?: string | null;
  /** Short label for the row inside the per-CSM rollup ("Acme Co —
   *  90% of cap"). Falls back to `label` if unset. */
  csmRollupLine?: string;
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
  /** What mode to default to when the modal opens. Per-CSM rollup
   *  is the team default — one message per owner with a count + a
   *  filtered-AM-tab link, easier to triage than N per-company
   *  pings. Per-company stays for cases where a CSM wants threaded
   *  replies against each account; combined for digest channels. */
  defaultMode?: "combined" | "per-company" | "per-csm";
  /**
   * Where the per-CSM rollup messages should deep-link to. The
   * modal appends `?csm=<handle>` to this href when rendering each
   * CSM's message so each link lands them on their filtered slice.
   * Example: "https://csm-dash.vercel.app/am?tab=past-due".
   */
  deepLinkBase?: string;
  /**
   * Phrase that finishes the rollup intro line — "...that need review
   * for {rollupContext}." Examples: "proactive outreach", "past-due".
   * Drives the auto-generated CTA: "Hey @CSM you have N accounts
   * that need review for {rollupContext}." Followed by the deep
   * link as the primary call-to-action.
   */
  rollupContext?: string;
  /**
   * Plural noun for the count itself — defaults to "accounts" but
   * surfaces (renewals, deliverability, etc.) can swap it. The full
   * line reads "you have *N noun* that need review for {context}".
   */
  rollupNoun?: string;
  /**
   * Admin-editable per-CSM rollup template, sourced from
   * settings.slack.channels[].rollup_template. Resolved with the
   * tokens documented on SlackChannel.rollup_template. Unset / empty
   * → falls back to the hard-coded DEFAULT_ROLLUP_TEMPLATE constant
   * so deployments without a custom template keep working.
   */
  rollupTemplate?: string;
  /**
   * When set, the per-CSM rollup also creates a personal todo for
   * each CSM the message goes to. The todo title is auto-built
   * from the rollup noun + count + deep link.
   */
  createTodoOnRollup?: boolean;
  onClose: () => void;
}

type Mode = "combined" | "per-company" | "per-csm";

// Re-export the shared default template so /settings/slack and
// other client callers can keep importing it from here. The actual
// constant lives in src/lib/integrations/slack-rollup.ts so server
// code (engine sweeps, crons) can use it without dragging a
// "use client" module into the server bundle.
export const DEFAULT_ROLLUP_TEMPLATE = SHARED_DEFAULT_TEMPLATE;

/** Pre-build the per-CSM rollup messages from the per-row list.
 *  Groups by csmHandle and emits ONE short message per group,
 *  rendered from the supplied rollup template (or the hard-coded
 *  default when none is set).
 *
 *  Unassigned rows ("csmHandle: null") collapse into one
 *  "Unassigned" group at the end so they don't get lost.
 *
 *  Stable across re-renders for a given input — pure function of
 *  the per-company list + deep-link base + template. */
function buildCsmRollupMessages(
  perCompany: BulkSlackMessage[],
  deepLinkBase: string | undefined,
  rollupNoun: string,
  rollupContext: string,
  rollupTemplate: string
): Array<{
  id: string;
  label: string;
  text: string;
  csmHandle: string | null;
  csmSlackId: string | null;
  count: number;
}> {
  const groups = new Map<
    string,
    {
      handle: string | null;
      slackId: string | null;
      rows: BulkSlackMessage[];
    }
  >();
  for (const m of perCompany) {
    const key = m.csmHandle ?? "__unassigned__";
    const g = groups.get(key) ?? {
      handle: m.csmHandle ?? null,
      slackId: m.csmSlackId ?? null,
      rows: [],
    };
    g.rows.push(m);
    if (!g.slackId && m.csmSlackId) g.slackId = m.csmSlackId;
    groups.set(key, g);
  }
  // Sorted output: named groups first (alpha by handle), unassigned
  // last. Stable so re-renders don't shuffle.
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    if (a === "__unassigned__") return 1;
    if (b === "__unassigned__") return -1;
    return a.localeCompare(b);
  });
  return ordered.map(([key, g]) => {
    const count = g.rows.length;
    const tokens = buildRollupTokens({
      csmHandle: g.handle,
      csmSlackId: g.slackId,
      count,
      rollupNoun,
      rollupContext,
      deepLinkBase,
    });
    const text = renderRollupTemplateShared(rollupTemplate, tokens);
    return {
      id: `csm:${key}`,
      label: tokens.csm_name,
      text,
      csmHandle: g.handle,
      csmSlackId: g.slackId,
      count,
    };
  });
}

export function SlackBulkCompose({
  title,
  initialCombinedText,
  perCompanyMessages,
  initialChannel,
  defaultMode = "per-csm",
  deepLinkBase,
  rollupContext = "review",
  rollupNoun = "accounts",
  rollupTemplate,
  createTodoOnRollup = false,
  onClose,
}: Props) {
  // Resolved template — caller can override via settings, falls back
  // to the documented default. Computed inline so a settings tweak
  // takes effect on the next render without a remount.
  const resolvedTemplate =
    rollupTemplate && rollupTemplate.trim()
      ? rollupTemplate
      : DEFAULT_ROLLUP_TEMPLATE;
  const [channel, setChannel] = useState(initialChannel);
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [combined, setCombined] = useState(initialCombinedText);
  const [perMessages, setPerMessages] = useState(perCompanyMessages);
  // Initial per-CSM messages derived from the per-company list. The
  // textarea owns the live editable copy so the CSM can tweak before
  // sending; this gets recomputed only if the perCompany list itself
  // changes (which doesn't happen mid-modal session — selected rows
  // are locked when the modal opens).
  const [csmMessages, setCsmMessages] = useState(() =>
    buildCsmRollupMessages(
      perCompanyMessages,
      deepLinkBase,
      rollupNoun,
      rollupContext,
      resolvedTemplate
    )
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function patchMessage(id: string, text: string) {
    setPerMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, text } : m))
    );
  }

  function patchCsmMessage(id: string, text: string) {
    setCsmMessages((prev) =>
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
      } else if (mode === "per-csm") {
        // Roll-up mode: one Slack message per CSM (with @mention +
        // count + filtered AM-tab link). Plus, after every send
        // completes, optionally create a personal todo for each
        // pinged CSM so the assignment shows up on their home page.
        const fails: string[] = [];
        let succeeded = 0;
        const sentHandles: string[] = [];
        for (const m of csmMessages) {
          if (!m.text.trim()) continue;
          try {
            await postOne(m.text);
            succeeded++;
            if (m.csmHandle) sentHandles.push(m.csmHandle);
          } catch (e) {
            fails.push(
              `${m.label} (${e instanceof Error ? e.message : "unknown"})`
            );
          }
        }
        let todoNote = "";
        if (createTodoOnRollup && sentHandles.length > 0) {
          // Auto-create a personal todo per pinged CSM. The endpoint
          // resolves handles → emails via the customer book, then
          // appends to each CSM's personal-todos KV row. Failure here
          // doesn't abort — the Slack messages already landed.
          try {
            const todoBody = {
              todos: csmMessages
                .filter((m) => m.csmHandle && m.text.trim())
                .map((m) => {
                  const sep =
                    deepLinkBase && deepLinkBase.includes("?") ? "&" : "?";
                  const link =
                    deepLinkBase && m.csmHandle
                      ? `${deepLinkBase}${sep}csm=${encodeURIComponent(m.csmHandle)}`
                      : null;
                  return {
                    csm_handle: m.csmHandle,
                    title: `Review ${m.count} ${rollupNoun} for ${rollupContext}`,
                    details: link
                      ? `Sent via dashboard Slack ping. Open: ${link}`
                      : `Sent via dashboard Slack ping.`,
                  };
                }),
            };
            const r = await fetch(
              "/api/personal-todos/bulk-create-for-csms",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(todoBody),
              }
            );
            if (r.ok) {
              const j = (await r.json()) as {
                created: number;
                failed: number;
              };
              todoNote = ` · created ${j.created} to-do${j.created === 1 ? "" : "s"}${j.failed > 0 ? ` (${j.failed} todo write failures)` : ""}`;
            } else {
              todoNote = " · to-do creation failed (Slack pings already sent)";
            }
          } catch {
            todoNote = " · to-do creation failed (Slack pings already sent)";
          }
        }
        const note =
          fails.length > 0 ? ` · failed: ${fails.join("; ")}` : "";
        setResult(
          `Sent ${succeeded}/${csmMessages.length} per-CSM rollup${
            csmMessages.length === 1 ? "" : "s"
          } ✓${note}${todoNote}`
        );
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
      : mode === "per-csm"
        ? csmMessages.every((m) => !m.text.trim())
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
                onClick={() => setMode("per-csm")}
                className={`px-3 py-1.5 ${
                  mode === "per-csm"
                    ? "bg-accent text-accent-fg font-medium"
                    : "bg-surface text-muted hover:text-fg"
                }`}
              >
                Per CSM ({csmMessages.length})
              </button>
              <button
                onClick={() => setMode("per-company")}
                className={`px-3 py-1.5 border-l border-border ${
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
              Per CSM bundles every selected row by owner — one
              roll-up message per CSM with a link to their filtered
              list. Per company sends one Slack message per row for
              threaded triage. Combined sends a single digest.
              {createTodoOnRollup
                ? " Per-CSM mode also auto-creates a personal to-do for each pinged CSM."
                : ""}
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
          ) : mode === "per-csm" ? (
            <div className="space-y-3">
              {csmMessages.map((m) => (
                <div key={m.id}>
                  <label className="text-xs text-muted block mb-1 flex items-center gap-2">
                    <span>{m.label}</span>
                    <span className="text-subtle font-mono">
                      ({m.count} account{m.count === 1 ? "" : "s"})
                    </span>
                    {!m.csmSlackId && m.csmHandle ? (
                      <span
                        className="text-amber-700 dark:text-amber-300"
                        title="No Slack ID mapped for this CSM — add one at /settings/slack to enable @-mentions and personal to-dos."
                      >
                        no Slack ID
                      </span>
                    ) : null}
                  </label>
                  <textarea
                    value={m.text}
                    onChange={(e) => patchCsmMessage(m.id, e.target.value)}
                    rows={6}
                    className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
                  />
                </div>
              ))}
              {csmMessages.length === 0 ? (
                <p className="text-sm text-subtle italic">
                  No rows selected.
                </p>
              ) : null}
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
                : mode === "per-csm"
                  ? `Send ${csmMessages.length} CSM roll-up${csmMessages.length === 1 ? "" : "s"}`
                  : `Send ${perMessages.length} message${
                      perMessages.length === 1 ? "" : "s"
                    }`}
          </button>
        </div>
      </div>
    </div>
  );
}
