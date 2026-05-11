"use client";

import { useEffect, useState } from "react";
import { DEFAULTS, type SettingsShape } from "@/lib/data/settings-types";
import type { RiskFlagCode } from "@/lib/types";

const FLAG_LABELS: Record<RiskFlagCode, string> = {
  A: "A — Dormant (no send 10+ days)",
  B: "B — No login (14+ days)",
  C: "C — Under tier (<75% of cap)",
  D: "D — Frustration signal",
  E: "E — No contact 90+ days",
  F: "F — Notable news",
  G: "G — CSM-flagged risk (Yellow/Red)",
  H: "H — Stale contact (>45 days)",
};

const FLAG_ORDER: RiskFlagCode[] = ["A", "B", "C", "D", "E", "F", "G", "H"];

export default function GeneralSettingsPage() {
  const [settings, setSettings] = useState<SettingsShape>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/settings");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSettings((await r.json()) as SettingsShape);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
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
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  function setFlagPeriod(code: RiskFlagCode, days: number) {
    setSettings((prev) => ({
      ...prev,
      flags: {
        ...prev.flags,
        [code]: { re_raise_days: Math.max(0, days || 0) },
      },
    }));
  }

  function setThreshold<K extends keyof SettingsShape["thresholds"]>(
    key: K,
    value: number
  ) {
    setSettings((prev) => ({
      ...prev,
      thresholds: { ...prev.thresholds, [key]: value },
    }));
  }

  return (
    <>
      {error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-3 mb-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-lg p-3 mb-3 text-sm text-emerald-800 dark:text-emerald-300">
          {message}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="bg-surface rounded-xl border border-border shadow-card p-4">
            <h2 className="text-sm font-semibold text-fg mb-1">
              Flag re-raise periods
            </h2>
            <p className="text-xs text-muted mb-3">
              When you mark a flag resolved (the &ldquo;I&rsquo;ve reached
              out&rdquo; checkbox), it stays hidden for this many days. After
              the period elapses, the flag re-fires automatically so the
              account comes back into view. Set to <strong>0</strong> for
              &ldquo;never re-raise&rdquo; (manual unresolve required).
            </p>
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="text-left border-b border-border">
                  <th className="px-2 py-1 font-medium">Flag</th>
                  <th className="px-2 py-1 font-medium w-24">Days</th>
                </tr>
              </thead>
              <tbody>
                {FLAG_ORDER.map((code) => (
                  <tr key={code} className="border-b border-border">
                    <td className="px-2 py-2 text-fg">
                      {FLAG_LABELS[code]}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        value={settings.flags[code].re_raise_days}
                        onChange={(e) =>
                          setFlagPeriod(code, Number(e.target.value))
                        }
                        className="w-20 px-2 py-1 border border-border-strong rounded-md text-sm"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="bg-surface rounded-xl border border-border shadow-card p-4">
            <h2 className="text-sm font-semibold text-fg mb-1">
              Thresholds
            </h2>
            <p className="text-xs text-muted mb-3">
              Trip-points the at-risk engine and table colorings use.
            </p>
            <ThresholdRow
              label="Flag A — days since last send to trip"
              value={settings.thresholds.days_no_send}
              onChange={(v) => setThreshold("days_no_send", v)}
              suffix="days"
            />
            <ThresholdRow
              label="Flag C — % of cap below which to trip"
              value={Math.round(settings.thresholds.pct_under_tier * 100)}
              onChange={(v) => setThreshold("pct_under_tier", v / 100)}
              suffix="%"
            />
            <ThresholdRow
              label="Flag H — days since last contacted to trip"
              value={settings.thresholds.days_no_contact_short}
              onChange={(v) => setThreshold("days_no_contact_short", v)}
              suffix="days"
            />
            <ThresholdRow
              label="Sub utilization — red threshold"
              value={settings.thresholds.util_red_pct}
              onChange={(v) => setThreshold("util_red_pct", v)}
              suffix="%"
            />
            <ThresholdRow
              label="Sub utilization — amber threshold"
              value={settings.thresholds.util_amber_pct}
              onChange={(v) => setThreshold("util_amber_pct", v)}
              suffix="%"
            />
            <ThresholdRow
              label="Ad-gap fallback — $/K subs per ad"
              value={settings.thresholds.ad_default_rate_per_k_subs_usd}
              onChange={(v) =>
                setThreshold("ad_default_rate_per_k_subs_usd", v)
              }
              suffix="USD"
            />
          </section>
        </div>
      )}

      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={save}
          disabled={saving || loading}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        <button
          onClick={load}
          className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
        >
          Reset
        </button>
      </div>
    </>
  );
}

function ThresholdRow({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  suffix: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
      <label className="text-sm text-muted">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 px-2 py-1 border border-border-strong rounded-md text-sm"
        />
        <span className="text-xs text-muted">{suffix}</span>
      </div>
    </div>
  );
}
