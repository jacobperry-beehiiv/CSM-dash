"use client";

import { useEffect, useState } from "react";
import {
  DEFAULTS,
  newChannelId,
  PAST_DUE_CHANNEL_ID,
  type SettingsShape,
  type SlackChannel,
} from "@/lib/data/settings-types";

export default function SlackSettingsPage() {
  const [settings, setSettings] = useState<SettingsShape>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline-form state for adding a new CSM. Both fields collected up
  // front so we don't end up with an empty Slack ID column waiting to
  // be filled (the old prompt() flow's failure mode).
  const [draftCsmHandle, setDraftCsmHandle] = useState("");
  const [draftCsmSlackId, setDraftCsmSlackId] = useState("");
  // Inline form for adding a new Slack channel destination.
  const [draftChannelLabel, setDraftChannelLabel] = useState("");
  const [draftChannelId, setDraftChannelId] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setSettings(j as SettingsShape))
      .catch((e) => setError(e instanceof Error ? e.message : "Unknown"))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      setSettings(json as SettingsShape);
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown");
    } finally {
      setSaving(false);
    }
  }

  function patchChannel(id: string, patch: Partial<SlackChannel>) {
    setSettings((prev) => ({
      ...prev,
      slack: {
        ...prev.slack,
        channels: prev.slack.channels.map((c) =>
          c.id === id ? { ...c, ...patch } : c
        ),
      },
    }));
  }

  function removeChannel(id: string) {
    if (id === PAST_DUE_CHANNEL_ID) {
      // Past-due is the one channel code paths still hardcode against —
      // keep it pinned so /am's "Send to Slack" button never lands on a
      // missing-config error. Admins can still blank out its channel ID
      // if they don't want it active.
      setError("The Past-due channel is reserved and can't be removed.");
      return;
    }
    setSettings((prev) => ({
      ...prev,
      slack: {
        ...prev.slack,
        channels: prev.slack.channels.filter((c) => c.id !== id),
      },
    }));
  }

  function addChannel() {
    const label = draftChannelLabel.trim();
    if (!label) {
      setError("Channel needs a label.");
      return;
    }
    setError(null);
    setSettings((prev) => {
      const id = newChannelId(
        label,
        prev.slack.channels.map((c) => c.id)
      );
      const seed: SlackChannel = {
        id,
        label,
        channel_id: draftChannelId.trim(),
        template: "",
      };
      return {
        ...prev,
        slack: { ...prev.slack, channels: [...prev.slack.channels, seed] },
      };
    });
    setDraftChannelLabel("");
    setDraftChannelId("");
  }

  function setCsmId(csm: string, userId: string) {
    setSettings((prev) => {
      const next = { ...prev.slack.csm_user_ids };
      if (userId.trim()) next[csm] = userId.trim();
      else delete next[csm];
      return { ...prev, slack: { ...prev.slack, csm_user_ids: next } };
    });
  }

  function addCsm() {
    const handle = draftCsmHandle.trim();
    const slackId = draftCsmSlackId.trim();
    if (!handle) {
      setError("CSM handle is required.");
      return;
    }
    if (!slackId) {
      setError("Slack user ID is required (e.g. U02ABC123).");
      return;
    }
    if (settings.slack.csm_user_ids[handle]) {
      setError(`A mapping for ${handle} already exists — edit it in the table below.`);
      return;
    }
    setError(null);
    setCsmId(handle, slackId);
    setDraftCsmHandle("");
    setDraftCsmSlackId("");
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  const csms = Object.keys(settings.slack.csm_user_ids).sort();

  return (
    <div className="space-y-4">
      {error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-lg p-3 text-sm text-emerald-800 dark:text-emerald-300">
          {message}
        </div>
      ) : null}

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">Slack channels</h2>
          <p className="text-xs text-muted mt-1">
            One row per alert type. Add as many as you need — wire
            different alerts to different channels by giving each a
            stable id (e.g.{" "}
            <code className="font-mono bg-surface-2 px-1 rounded">past_due</code>,{" "}
            <code className="font-mono bg-surface-2 px-1 rounded">at_risk</code>).
            App code looks each up by id; renaming the label is free.
          </p>
        </div>

        <div className="space-y-3">
          {settings.slack.channels.map((c) => (
            <div
              key={c.id}
              className="border border-border rounded-md p-3 space-y-2 bg-canvas/30"
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={c.label}
                  onChange={(e) => patchChannel(c.id, { label: e.target.value })}
                  className="flex-1 min-w-[160px] px-2 py-1 border border-border-strong rounded-md text-sm font-medium"
                  placeholder="Channel label"
                />
                <code className="text-[11px] text-subtle font-mono">{c.id}</code>
                <button
                  onClick={() => removeChannel(c.id)}
                  className="text-subtle hover:text-red-600 text-sm px-1"
                  title={
                    c.id === PAST_DUE_CHANNEL_ID
                      ? "Reserved channel — can't be removed."
                      : "Remove this channel"
                  }
                  disabled={c.id === PAST_DUE_CHANNEL_ID}
                >
                  ✕
                </button>
              </div>
              <div>
                <label className="text-xs text-muted block mb-1">
                  Slack channel ID
                </label>
                <input
                  type="text"
                  value={c.channel_id}
                  onChange={(e) =>
                    patchChannel(c.id, { channel_id: e.target.value })
                  }
                  placeholder="C0AMK142WUR"
                  className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-muted block mb-1">
                  Default message template
                </label>
                <textarea
                  value={c.template}
                  onChange={(e) =>
                    patchChannel(c.id, { template: e.target.value })
                  }
                  rows={c.id === PAST_DUE_CHANNEL_ID ? 8 : 5}
                  placeholder="Slack mrkdwn — {{token}}s render server-side."
                  className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
                />
                {c.id === PAST_DUE_CHANNEL_ID ? (
                  <p className="text-[11px] text-muted mt-1">
                    Past-due tokens:{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{total_arr}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{count}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{count_plural}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{account_list}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{customer_ids}}"}</code>
                    {" "}(comma-separated <code className="font-mono">cus_*</code> Stripe IDs from the selected rows).
                  </p>
                ) : null}
              </div>
              {c.id === PAST_DUE_CHANNEL_ID ? (
                <div>
                  <label className="text-xs text-muted block mb-1">
                    {"{{account_list}}"} row format
                  </label>
                  <textarea
                    value={c.row_template ?? ""}
                    onChange={(e) =>
                      patchChannel(c.id, { row_template: e.target.value })
                    }
                    rows={2}
                    placeholder="• *{{email}}* — {{charge_amount}} failed charge, {{arr}} ARR (CSM: {{csm}})"
                    className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
                  />
                  <p className="text-[11px] text-muted mt-1">
                    One row per selected past-due account, joined with
                    newlines into {"{{account_list}}"}. Per-row tokens:{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{email}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{customer_id}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{subscription_id}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{plan}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{arr}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{charge_amount}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{charge_status}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{failure_code}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{failure_message}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{attempted_at}}"}</code>,{" "}
                    <code className="font-mono bg-surface-2 px-1 rounded">{"{{csm}}"}</code>
                    {" "}(renders as a Slack @mention when the CSM has a Slack ID mapped).
                  </p>
                  <details className="mt-2 text-[11px] text-muted">
                    <summary className="cursor-pointer hover:text-fg select-none">
                      Hyperlinks in Slack messages
                    </summary>
                    <div className="mt-2 space-y-2 pl-2 border-l-2 border-border">
                      <p>
                        Slack mrkdwn renders links as{" "}
                        <code className="font-mono bg-surface-2 px-1 rounded">
                          {"<URL|display text>"}
                        </code>
                        . Merge tags interpolate into both halves, so you
                        can build clickable rows by wrapping a token in
                        the angle-bracket form.
                      </p>
                      <p className="font-medium text-fg">
                        Link the email to the Stripe customer page:
                      </p>
                      <pre className="bg-surface-2 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all">
{`• <https://dashboard.stripe.com/customers/{{customer_id}}|{{email}}> — {{charge_amount}} failed, {{arr}} ARR (CSM: {{csm}})`}
                      </pre>
                      <p className="font-medium text-fg">
                        Link the plan name to the Stripe subscription:
                      </p>
                      <pre className="bg-surface-2 px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all">
{`• *{{email}}* — <https://dashboard.stripe.com/subscriptions/{{subscription_id}}|{{plan}}> · {{charge_amount}} failed ({{failure_code}})`}
                      </pre>
                      <p className="font-medium text-fg">Tip</p>
                      <p>
                        Slack doesn&apos;t auto-link bare URLs that contain
                        merge tag content reliably — always wrap them in{" "}
                        <code className="font-mono bg-surface-2 px-1 rounded">
                          {"<...|...>"}
                        </code>
                        . If you omit the{" "}
                        <code className="font-mono bg-surface-2 px-1 rounded">|text</code>{" "}
                        portion the URL itself is shown.
                      </p>
                    </div>
                  </details>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="border-t border-border pt-3 space-y-2">
          <p className="text-xs font-medium text-muted">Add a new channel</p>
          <div className="flex flex-wrap items-stretch gap-2">
            <input
              type="text"
              value={draftChannelLabel}
              onChange={(e) => setDraftChannelLabel(e.target.value)}
              placeholder="Label (e.g. At-risk alerts)"
              className="flex-1 min-w-[200px] px-3 py-2 border border-border-strong rounded-md text-sm"
            />
            <input
              type="text"
              value={draftChannelId}
              onChange={(e) => setDraftChannelId(e.target.value)}
              placeholder="Slack channel ID (e.g. C0AMK142WUR)"
              className="flex-1 min-w-[200px] px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
            />
            <button
              onClick={addChannel}
              className="px-3 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
            >
              + Add channel
            </button>
          </div>
        </div>
      </section>

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg">CSM Slack IDs</h2>
        <p className="text-xs text-muted">
          Map each CSM&rsquo;s internal handle (the Metabase{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">
            customer_success_manager
          </code>{" "}
          format, e.g.{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">Jacob_Perry</code>
          ) to their Slack user ID. Used by alerts to render an actual
          @mention rather than a plain name.
        </p>

        <div className="flex flex-wrap items-stretch gap-2 border border-border rounded-md p-2 bg-canvas/30">
          <input
            type="text"
            value={draftCsmHandle}
            onChange={(e) => setDraftCsmHandle(e.target.value)}
            placeholder="CSM handle (e.g. Jacob_Perry)"
            className="flex-1 min-w-[180px] px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
          />
          <input
            type="text"
            value={draftCsmSlackId}
            onChange={(e) => setDraftCsmSlackId(e.target.value)}
            placeholder="Slack user ID (e.g. U02ABC123)"
            className="flex-1 min-w-[180px] px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
          />
          <button
            onClick={addCsm}
            className="px-3 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
          >
            + Add CSM
          </button>
        </div>

        {csms.length === 0 ? (
          <p className="text-xs text-subtle italic">
            No CSM mappings yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr className="text-left border-b border-border">
                <th className="px-2 py-1 font-medium">CSM handle</th>
                <th className="px-2 py-1 font-medium">Slack user ID</th>
                <th className="px-2 py-1 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {csms.map((csm) => (
                <tr key={csm} className="border-b border-border">
                  <td className="px-2 py-2 text-fg font-mono">{csm}</td>
                  <td className="px-2 py-2">
                    <input
                      type="text"
                      value={settings.slack.csm_user_ids[csm]}
                      onChange={(e) => setCsmId(csm, e.target.value)}
                      placeholder="U02ABC123"
                      className="w-full px-2 py-1 border border-border-strong rounded-md text-sm font-mono"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => setCsmId(csm, "")}
                      className="px-2 py-1 text-xs border border-red-300 text-red-700 rounded-md hover:bg-red-50 dark:bg-red-500/10"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
