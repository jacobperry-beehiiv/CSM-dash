"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_LIFECYCLE_STAGES,
  DEFAULT_PROACTIVE_OUTREACH_STATUSES,
  DEFAULT_TODO_TRIGGER_EMOJI,
  DEFAULTS,
  newChannelId,
  PAST_DUE_CHANNEL_ID,
  type SettingsShape,
  type SlackChannel,
} from "@/lib/data/settings-types";

/** Slack's canonical channel-ID regex (^[CGDZ][A-Z0-9]{8,}$). Some
 *  endpoints (chat.postMessage) accept names; others (notably
 *  files.completeUploadExternal — the screenshot upload path) strictly
 *  require the ID. We warn here so admins don't paste a channel name
 *  and only find out the upload silently breaks. */
const CHANNEL_ID_REGEX = /^[CGDZ][A-Z0-9]{8,}$/;
/** Slack user-ID regex (^[UW]…). We surface a tailored hint when the
 *  admin pastes a user ID — the resolver auto-opens a DM, but the
 *  hint makes the intent visible. */
const USER_ID_REGEX = /^[UW][A-Z0-9]{8,}$/;

function ChannelIdHint({ value }: { value: string }) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (CHANNEL_ID_REGEX.test(trimmed)) return null;
  // U… / W… → user ID; the resolver opens a DM via conversations.open.
  // Surface this so it's clear that's intentional, not a misconfig.
  if (USER_ID_REGEX.test(trimmed)) {
    return (
      <p className="mt-1 text-[11px] text-blue-700 dark:text-blue-300">
        Looks like a Slack user ID — messages will be sent as a DM to
        that user via <code className="font-mono">conversations.open</code>.
        Requires the bot to have <code className="font-mono">im:write</code>
        {" "}scope and the receiving user to allow DMs from apps. To
        send to a channel instead, paste a channel ID like{" "}
        <code className="font-mono">C0AMK142WUR</code>.
      </p>
    );
  }
  return (
    <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
      Doesn&rsquo;t look like a Slack channel ID. The screenshot upload
      flow (files.completeUploadExternal) requires a canonical ID like{" "}
      <code className="font-mono">C0AMK142WUR</code>. Open Slack →
      channel name → <em>View channel details</em> → bottom of the
      panel; copy the ID there. Text-only posts still work with a
      name, but image uploads will fail. To DM a single user instead,
      paste their user ID (starts with <code className="font-mono">U</code>).
    </p>
  );
}

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
                <ChannelIdHint value={c.channel_id} />
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
        <h2 className="text-sm font-semibold text-fg">
          Proactive outreach schedule
        </h2>
        <p className="text-xs text-muted">
          The daily GitHub Actions cron sweeps the Enterprise cohort
          at <code className="font-mono bg-surface-2 px-1 rounded">≥75%</code>
          {" "}of cap, posts a Slack ping for newly-crossing accounts,
          and nudges AM after 5 days of no logged outreach. Pause the
          schedule here when you want to mute auto-pings without
          disabling the engine — the manual{" "}
          <em>📣 Ping N selected on Slack</em> button on the AM
          Proactive Outreach tab still works either way.
        </p>
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={settings.am?.proactive_outreach_sweep_enabled !== false}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                am: {
                  ...(prev.am ?? {}),
                  proactive_outreach_sweep_enabled: e.target.checked,
                },
              }))
            }
            className="mt-0.5 h-4 w-4 rounded border-border-strong cursor-pointer"
          />
          <span>
            <span className="font-medium text-fg">
              Scheduled sweep enabled
            </span>
            <span className="block text-xs text-muted">
              When off, the daily cron call to{" "}
              <code className="font-mono bg-surface-2 px-1 rounded">
                /api/proactive-outreach/sweep
              </code>{" "}
              short-circuits with{" "}
              <code className="font-mono">{"{ disabled: true }"}</code>{" "}
              — no Slack messages fire, no nudges go out. Default: on.
            </span>
          </span>
        </label>
      </section>

      <ProactiveOutreachStatusesSection
        statuses={settings.am?.proactive_outreach_statuses ?? []}
        onChange={(next) =>
          setSettings((prev) => ({
            ...prev,
            am: {
              ...(prev.am ?? {}),
              proactive_outreach_statuses: next,
            },
          }))
        }
      />

      <LifecycleStagesSection
        stages={settings.am?.lifecycle_stages ?? []}
        onChange={(next) =>
          setSettings((prev) => ({
            ...prev,
            am: {
              ...(prev.am ?? {}),
              lifecycle_stages: next,
            },
          }))
        }
      />

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg">
          Per-CSM review digest
        </h2>
        <p className="text-xs text-muted">
          One Slack message per CSM each morning summarizing how many
          accounts need their attention — past-due / approaching cap /
          upcoming renewal. The message links each count to the
          dashboard filtered to that CSM&rsquo;s book + the workflow,
          showing only rows still pending action. CSMs mark each one
          <code className="font-mono bg-surface-2 px-1 rounded">Reach
            out</code>{" "}
          /{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">Skip</code>{" "}
          /{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">Done</code>{" "}
          on the row, and the next digest only resurfaces what&rsquo;s
          still pending.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs text-muted whitespace-nowrap min-w-[140px]">
            Slack channel ID
          </span>
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={settings.am?.daily_digest_channel_id ?? ""}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  am: {
                    ...(prev.am ?? {}),
                    daily_digest_channel_id: e.target.value,
                  },
                }))
              }
              placeholder="C0XXXXXXXXX"
              className="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono"
            />
            <ChannelIdHint
              value={settings.am?.daily_digest_channel_id ?? ""}
            />
          </div>
        </label>
        <p className="text-[11px] text-muted">
          Channel ID (e.g.{" "}
          <code className="font-mono">C0XXXXXXXXX</code>) — must
          include the bot user. Leave blank to disable the digest:
          the cron will return{" "}
          <code className="font-mono">no_channel_configured: true</code>{" "}
          rather than silently dropping messages.
        </p>
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

      <SlackInboundSection
        triggerEmoji={
          settings.personal_todos?.trigger_emoji ?? DEFAULT_TODO_TRIGGER_EMOJI
        }
        onTriggerEmojiChange={(next) =>
          setSettings((prev) => ({
            ...prev,
            personal_todos: {
              ...(prev.personal_todos ?? {}),
              trigger_emoji: next,
            },
          }))
        }
      />

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

/**
 * Slack inbound checklist + personal-todos trigger emoji. The
 * dashboard is mostly outbound today; the personal-todos webhook
 * is the first surface that *receives* from Slack, so this section
 * spells out the (one-time) Slack-app config an admin has to do
 * before the slash command / DM / reaction features start working.
 */
function SlackInboundSection({
  triggerEmoji,
  onTriggerEmojiChange,
}: {
  triggerEmoji: string;
  onTriggerEmojiChange: (next: string) => void;
}) {
  const dashUrl =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://csm-dash.vercel.app";
  const webhookUrl = `${dashUrl.replace(/\/+$/, "")}/api/slack-webhook`;
  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-fg">
        Slack inbound — personal to-dos
      </h2>
      <p className="text-xs text-muted">
        One-time Slack app config so users can create personal to-dos via
        Slack (slash command, DM, or reacting to a message). Verification
        relies on a <code className="font-mono">SLACK_SIGNING_SECRET</code> env
        var on the dashboard — set that in Vercel before enabling the
        webhook in Slack.
      </p>

      <div className="space-y-2 text-xs">
        <div className="flex items-start gap-2">
          <span className="mt-0.5">1.</span>
          <div className="flex-1">
            <p className="text-fg font-medium">Set the request URL</p>
            <p className="text-muted">
              In Slack app config, point both the slash command and the
              Event Subscriptions request URL to:
            </p>
            <code className="block mt-1 font-mono text-fg bg-canvas border border-border rounded px-2 py-1 break-all">
              {webhookUrl}
            </code>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <span className="mt-0.5">2.</span>
          <div className="flex-1">
            <p className="text-fg font-medium">Add bot scopes</p>
            <p className="text-muted">
              On top of what the bot already has (
              <code className="font-mono">chat:write</code>,{" "}
              <code className="font-mono">im:write</code>,{" "}
              <code className="font-mono">files:write</code>,{" "}
              <code className="font-mono">channels:read</code>,{" "}
              <code className="font-mono">groups:read</code>), add:
            </p>
            <ul className="mt-1 ml-5 list-disc text-muted">
              <li>
                <code className="font-mono">commands</code> — for the{" "}
                <code className="font-mono">/todo</code> slash command
              </li>
              <li>
                <code className="font-mono">im:history</code> — to read
                inbound DMs
              </li>
              <li>
                <code className="font-mono">channels:history</code> /{" "}
                <code className="font-mono">groups:history</code> — to read
                the reacted-to message text
              </li>
              <li>
                <code className="font-mono">reactions:read</code> — for
                the reaction trigger
              </li>
              <li>
                <code className="font-mono">users:read</code> +{" "}
                <code className="font-mono">users:read.email</code> — for
                resolving inbound user identity (the .email scope is used as
                the fallback when a CSM is mapped in the CSM Slack IDs table
                but has no accounts in the customer book yet)
              </li>
            </ul>
            <p className="mt-1 text-muted">
              Re-install the app to the workspace to grant the new scopes.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <span className="mt-0.5">3.</span>
          <div className="flex-1">
            <p className="text-fg font-medium">Slash command</p>
            <p className="text-muted">
              Add <code className="font-mono">/todo</code> with the request
              URL above. Optional usage hint: «What needs doing? on:YYYY-MM-DD
              due:YYYY-MM-DD !high|!medium|!low»
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <span className="mt-0.5">4.</span>
          <div className="flex-1">
            <p className="text-fg font-medium">Event subscriptions</p>
            <p className="text-muted">
              Enable Event Subscriptions and subscribe to these bot
              events:
            </p>
            <ul className="mt-1 ml-5 list-disc text-muted">
              <li>
                <code className="font-mono">message.im</code> — DMs to the
                bot become to-dos
              </li>
              <li>
                <code className="font-mono">reaction_added</code> —
                reacting to any message with the trigger emoji captures it
              </li>
            </ul>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <span className="mt-0.5">5.</span>
          <div className="flex-1">
            <p className="text-fg font-medium">CSM ↔ Slack ID mapping</p>
            <p className="text-muted">
              Every CSM who wants to use the Slack inputs needs an entry in
              the «CSM Slack IDs» section above. Inbound resolves Slack
              user_id → handle (from that map) → email (from the customer
              book) → KV slice. Unmapped users get a friendly bounce DM.
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-3 space-y-1">
        <label className="text-xs font-medium text-fg block">
          Reaction emoji
        </label>
        <p className="text-xs text-muted">
          Slack emoji name (no colons) that triggers «create a to-do from
          this message». Default <code className="font-mono">white_check_mark</code>{" "}
          (✅). Try <code className="font-mono">pushpin</code> or a custom
          workspace emoji if ✅ collides with other team norms.
        </p>
        <input
          type="text"
          value={triggerEmoji}
          onChange={(e) => onTriggerEmojiChange(e.target.value.trim())}
          placeholder={DEFAULT_TODO_TRIGGER_EMOJI}
          className="px-2 py-1 text-sm font-mono border border-border-strong rounded-md bg-surface text-fg w-full max-w-xs"
        />
      </div>
    </section>
  );
}

/** Reusable section for managing a string-list setting — used for
 *  both Proactive Outreach statuses and Renewals lifecycle stages.
 *  Add / remove with Enter to commit; "Restore defaults" reseeds
 *  the list when needed. Empty list lets the consuming dropdown
 *  fall back to its own constant. */
function StringListSection({
  title,
  description,
  values,
  defaults,
  inputPlaceholder,
  addLabel,
  emptyHint,
  restoreTitle,
  onChange,
}: {
  title: string;
  description: React.ReactNode;
  values: string[];
  defaults: string[];
  inputPlaceholder: string;
  addLabel: string;
  emptyHint: string;
  restoreTitle: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const value = draft.trim();
    if (!value) return;
    if (values.includes(value)) {
      setDraft("");
      return;
    }
    onChange([...values, value]);
    setDraft("");
  }

  function remove(s: string) {
    onChange(values.filter((x) => x !== s));
  }

  function restoreDefaults() {
    onChange([...defaults]);
  }

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      <p className="text-xs text-muted">{description}</p>

      <div className="flex flex-wrap gap-1.5">
        {values.length === 0 ? (
          <span className="text-xs text-subtle italic">{emptyHint}</span>
        ) : (
          values.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border bg-canvas/40"
            >
              <span className="font-mono">{s}</span>
              <button
                type="button"
                onClick={() => remove(s)}
                aria-label={`Remove ${s}`}
                title={`Remove ${s}`}
                className="text-muted hover:text-red-600"
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={inputPlaceholder}
          className="px-3 py-2 border border-border-strong rounded-md text-sm min-w-[240px] flex-1 sm:flex-initial"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="px-3 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {addLabel}
        </button>
        <button
          type="button"
          onClick={restoreDefaults}
          className="px-3 py-2 border border-border-strong rounded-md text-sm hover:bg-canvas"
          title={restoreTitle}
        >
          Restore defaults
        </button>
      </div>
    </section>
  );
}

/** Manage the configurable status list that drives the Status column
 *  dropdown on the AM Proactive Outreach panel. Thin wrapper around
 *  StringListSection so the existing call site keeps working. */
function ProactiveOutreachStatusesSection({
  statuses,
  onChange,
}: {
  statuses: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <StringListSection
      title="Proactive outreach statuses"
      description={
        <>
          Drives the <strong>Status</strong> column dropdown on the AM
          Proactive Outreach panel.{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">
            Pinged
          </code>{" "}
          is auto-applied when a Slack ping fires;{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">
            Outreach made
          </code>{" "}
          is auto-applied when a draft is created via the dashboard.
          The rest of the list is manual workflow labels — rename
          them to match how the team talks ("In follow-up", "Renewal
          won", whatever).
        </>
      }
      values={statuses}
      defaults={DEFAULT_PROACTIVE_OUTREACH_STATUSES}
      inputPlaceholder="New status (e.g. Renewal at risk)"
      addLabel="+ Add status"
      emptyHint="No statuses configured — dropdown will fall back to the built-in defaults."
      restoreTitle="Reset to the built-in list — Pinged, Outreach made, Awaiting response, Renewed, Lost."
      onChange={onChange}
    />
  );
}

/** Lifecycle stages — drives the Lifecycle column dropdown on /am
 *  Renewals. Same UX as the Proactive Outreach statuses section. */
function LifecycleStagesSection({
  stages,
  onChange,
}: {
  stages: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <StringListSection
      title="Renewals lifecycle stages"
      description={
        <>
          Drives the <strong>Lifecycle</strong> column dropdown on the
          /am Renewals tab. Pure workflow labels — pick whatever
          terminology fits how the team tracks accounts from
          prospect to churn.
        </>
      }
      values={stages}
      defaults={DEFAULT_LIFECYCLE_STAGES}
      inputPlaceholder="New stage (e.g. Renewal at risk)"
      addLabel="+ Add stage"
      emptyHint="No stages configured — dropdown will fall back to the built-in defaults."
      restoreTitle="Reset to the built-in list — Prospect, Onboarding, Active, At risk, Renewal conversation, Churned."
      onChange={onChange}
    />
  );
}
