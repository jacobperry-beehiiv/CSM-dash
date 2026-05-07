"use client";

import { useEffect, useState } from "react";
import { DEFAULTS, type SettingsShape } from "@/lib/data/settings-types";

export default function SlackSettingsPage() {
  const [settings, setSettings] = useState<SettingsShape>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  function setSlack<K extends keyof SettingsShape["slack"]>(
    key: K,
    value: SettingsShape["slack"][K]
  ) {
    setSettings((prev) => ({
      ...prev,
      slack: { ...prev.slack, [key]: value },
    }));
  }

  function setCsmId(csm: string, userId: string) {
    setSettings((prev) => {
      const next = { ...prev.slack.csm_user_ids };
      if (userId.trim()) next[csm] = userId.trim();
      else delete next[csm];
      return { ...prev, slack: { ...prev.slack, csm_user_ids: next } };
    });
  }

  function addCsmRow() {
    const csm = prompt("CSM internal handle (e.g. Jacob_Perry)");
    if (csm && csm.trim()) {
      setCsmId(csm.trim(), "");
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  const csms = Object.keys(settings.slack.csm_user_ids).sort();

  return (
    <div className="space-y-4">
      {error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
          {message}
        </div>
      ) : null}

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">
          Past-due Slack alert
        </h2>
        <p className="text-xs text-gray-500">
          Channel and default message used by the AM &rarr; Past Due tab&rsquo;s
          &ldquo;Slack the past-due channel&rdquo; button. The send dialog lets
          you tweak the message before sending; this is just the starting
          point.
        </p>
        <div>
          <label className="text-xs text-gray-500 block mb-1">
            Default channel ID
          </label>
          <input
            type="text"
            value={settings.slack.past_due_channel}
            onChange={(e) => setSlack("past_due_channel", e.target.value)}
            placeholder="C0AMK142WUR"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">
            Default message template
          </label>
          <textarea
            value={settings.slack.past_due_template}
            onChange={(e) => setSlack("past_due_template", e.target.value)}
            rows={10}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
          />
          <p className="text-[11px] text-gray-500 mt-1">
            Slack mrkdwn. Available tokens:{" "}
            <code className="font-mono bg-gray-100 px-1 rounded">{"{{total_arr}}"}</code>,{" "}
            <code className="font-mono bg-gray-100 px-1 rounded">{"{{count}}"}</code>,{" "}
            <code className="font-mono bg-gray-100 px-1 rounded">{"{{count_plural}}"}</code>,{" "}
            <code className="font-mono bg-gray-100 px-1 rounded">{"{{account_list}}"}</code>.
          </p>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-gray-900">CSM Slack IDs</h2>
          <button
            onClick={addCsmRow}
            className="px-2 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50"
          >
            + Add CSM
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Map each CSM&rsquo;s internal handle (the Metabase{" "}
          <code className="font-mono bg-gray-100 px-1 rounded">
            customer_success_manager
          </code>{" "}
          format, e.g.{" "}
          <code className="font-mono bg-gray-100 px-1 rounded">Jacob_Perry</code>
          ) to their Slack user ID. Used by the past-due alert to render an
          actual @mention rather than a plain name.
        </p>
        {csms.length === 0 ? (
          <p className="text-xs text-gray-400 italic">
            No CSM mappings yet — click + Add CSM.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr className="text-left border-b border-gray-200">
                <th className="px-2 py-1 font-medium">CSM handle</th>
                <th className="px-2 py-1 font-medium">Slack user ID</th>
                <th className="px-2 py-1 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {csms.map((csm) => (
                <tr key={csm} className="border-b border-gray-100">
                  <td className="px-2 py-2 text-gray-800 font-mono">{csm}</td>
                  <td className="px-2 py-2">
                    <input
                      type="text"
                      value={settings.slack.csm_user_ids[csm]}
                      onChange={(e) => setCsmId(csm, e.target.value)}
                      placeholder="U02ABC123"
                      className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm font-mono"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => setCsmId(csm, "")}
                      className="px-2 py-1 text-xs border border-red-300 text-red-700 rounded-md hover:bg-red-50"
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
          className="px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
