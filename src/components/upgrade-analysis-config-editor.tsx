"use client";

import { useMemo, useState } from "react";
import type {
  UpgradeAnalysisConfig,
  UpgradeAnalysisConfigOverrides,
} from "@/lib/data/upgrade-analysis-config-types";

/**
 * Threshold registry editor for /settings/upgrade-analysis. Mirrors
 * the wins-config-editor shape:
 *   - One card per group (complaints, deferrals, engagement, volume,
 *     escalation)
 *   - Number inputs render placeholder = the shipped default
 *   - Save writes the full overrides bundle; server strips any value
 *     equal to the default so future default changes roll forward
 *
 * `escalation.slack_escalation_terms` is a string[] rather than a
 * number, so it gets a textarea (one term per line).
 */

interface Props {
  defaults: UpgradeAnalysisConfig;
  initialOverrides: UpgradeAnalysisConfigOverrides;
  meta: { updated_at: string | null; updated_by: string | null };
}

const GROUP_LABELS: Record<keyof UpgradeAnalysisConfig, string> = {
  complaints: "Complaint / spam thresholds",
  deferrals: "Deferral / rejection thresholds",
  engagement: "Engagement (verified clicks) thresholds",
  volume: "Volume + trigger settings",
  escalation: "Escalation rules",
};

const GROUP_DESCRIPTIONS: Record<keyof UpgradeAnalysisConfig, string> = {
  complaints:
    "Rate-based, not count-based. Comcast has its own red line since a Comcast spike is pub-attributable.",
  deferrals:
    "Real-rejection rate (Kumo `0.0.0.0` queue deferrals are excluded automatically).",
  engagement:
    "Trusts verified clicks over raw opens — Apple MPP inflates raw open rates.",
  volume:
    "Freshness guard prevents accidental double-scans. Window lengths tune the ClickHouse cost of a scan.",
  escalation:
    "Structural rules that flip `escalation.needed` on top of the per-pillar scores.",
};

const FIELD_LABELS: Record<string, string> = {
  blended_watch: "Blended complaint rate — watch",
  blended_critical: "Blended complaint rate — critical",
  comcast_red: "Comcast complaint rate — red line",
  provider_ratio_amber:
    "Provider vs blended ratio to promote amber (multiple)",
  enforcement_rate: "D&C composite complaint enforcement rate",
  enforcement_abs_floor: "D&C composite complaint absolute count floor",
  watch: "Deferral rate — watch",
  critical: "Deferral rate — critical",
  hard_bounce_red: "Hard bounce rate — red",
  unsub_watch: "Unsubscribe rate — watch",
  unsub_critical: "Unsubscribe rate — critical",
  hollow_verified_click_rate:
    "Verified click rate — below this the list is 'hollow'",
  ctor_healthy: "Verified CTOR — healthy floor",
  approaching_cap: "Approaching-cap trigger (fraction of subscriber max)",
  freshness_hours: "Freshness guard (hours)",
  funnel_window_days: "Funnel lookback (days)",
  provider_window_days: "Provider lookback (days)",
  acquisition_weekly_lookback: "Acquisition weekly rows to fetch",
  escalate_on_pillar: "Escalate when a pillar score reaches (red / amber)",
  amber_pillars_to_escalate:
    "Multi-amber escalation floor (count of amber pillars)",
};

export function UpgradeAnalysisConfigEditor({
  defaults,
  initialOverrides,
  meta,
}: Props) {
  const [draft, setDraft] = useState<UpgradeAnalysisConfigOverrides>(
    initialOverrides
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialOverrides),
    [draft, initialOverrides]
  );

  function setNumberField<G extends keyof UpgradeAnalysisConfig>(
    group: G,
    field: string,
    value: number | null
  ) {
    setDraft((prev) => {
      const next: UpgradeAnalysisConfigOverrides = { ...prev };
      const cur = { ...((next[group] ?? {}) as Record<string, unknown>) };
      if (value == null || Number.isNaN(value)) {
        delete cur[field];
      } else {
        cur[field] = value;
      }
      if (Object.keys(cur).length === 0) {
        delete next[group];
      } else {
        next[group] = cur as UpgradeAnalysisConfigOverrides[G];
      }
      return next;
    });
  }

  function setStringField<G extends keyof UpgradeAnalysisConfig>(
    group: G,
    field: string,
    value: string | null
  ) {
    setDraft((prev) => {
      const next: UpgradeAnalysisConfigOverrides = { ...prev };
      const cur = { ...((next[group] ?? {}) as Record<string, unknown>) };
      if (value == null || value === "") {
        delete cur[field];
      } else {
        cur[field] = value;
      }
      if (Object.keys(cur).length === 0) {
        delete next[group];
      } else {
        next[group] = cur as UpgradeAnalysisConfigOverrides[G];
      }
      return next;
    });
  }

  function setStringArrayField<G extends keyof UpgradeAnalysisConfig>(
    group: G,
    field: string,
    value: string[] | null
  ) {
    setDraft((prev) => {
      const next: UpgradeAnalysisConfigOverrides = { ...prev };
      const cur = { ...((next[group] ?? {}) as Record<string, unknown>) };
      if (!value || value.length === 0) {
        delete cur[field];
      } else {
        cur[field] = value;
      }
      if (Object.keys(cur).length === 0) {
        delete next[group];
      } else {
        next[group] = cur as UpgradeAnalysisConfigOverrides[G];
      }
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch("/api/upgrade-analysis/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: draft }),
      });
      const body = (await r.json()) as {
        ok?: boolean;
        overrides?: UpgradeAnalysisConfigOverrides;
        error?: string;
      };
      if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`);
      // Server strips overrides that match defaults — reflect that in
      // the local state so the "dirty" indicator resets.
      setDraft(body.overrides ?? {});
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {meta.updated_at ? (
        <p className="text-xs text-muted">
          Last saved{" "}
          {new Date(meta.updated_at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          {meta.updated_by ? ` by ${meta.updated_by}` : null}.
        </p>
      ) : (
        <p className="text-xs text-muted italic">
          No overrides on file yet — engine runs against shipped defaults.
        </p>
      )}

      {(Object.keys(defaults) as Array<keyof UpgradeAnalysisConfig>).map(
        (groupKey) => (
          <div
            key={groupKey}
            className="border border-border rounded-md bg-surface p-4"
          >
            <h3 className="text-sm font-semibold text-fg">
              {GROUP_LABELS[groupKey]}
            </h3>
            <p className="text-xs text-muted mt-0.5 mb-3">
              {GROUP_DESCRIPTIONS[groupKey]}
            </p>
            <GroupFields
              groupKey={groupKey}
              defaults={defaults[groupKey]}
              overrides={draft[groupKey]}
              onNumber={(field, val) => setNumberField(groupKey, field, val)}
              onString={(field, val) => setStringField(groupKey, field, val)}
              onStringArray={(field, val) =>
                setStringArrayField(groupKey, field, val)
              }
            />
          </div>
        )
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {message ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {message}
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-red-700 dark:text-red-300">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Group rendering ─────────────────────────────────────────────────────

function GroupFields({
  groupKey,
  defaults,
  overrides,
  onNumber,
  onString,
  onStringArray,
}: {
  groupKey: keyof UpgradeAnalysisConfig;
  defaults: UpgradeAnalysisConfig[keyof UpgradeAnalysisConfig];
  overrides:
    | UpgradeAnalysisConfigOverrides[keyof UpgradeAnalysisConfig]
    | undefined;
  onNumber: (field: string, val: number | null) => void;
  onString: (field: string, val: string | null) => void;
  onStringArray: (field: string, val: string[] | null) => void;
}) {
  const entries = Object.entries(defaults as unknown as Record<string, unknown>);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {entries.map(([fieldKey, defaultValue]) => {
        const overrideValue = (overrides as Record<string, unknown> | undefined)?.[
          fieldKey
        ];
        const currentValue = overrideValue ?? defaultValue;
        const label = FIELD_LABELS[fieldKey] ?? fieldKey;
        const isString = typeof defaultValue === "string";
        const isArray = Array.isArray(defaultValue);
        return (
          <div key={fieldKey}>
            <label className="text-xs font-medium text-fg block mb-0.5">
              {label}
            </label>
            {isArray ? (
              <textarea
                rows={4}
                className="w-full font-mono text-xs px-2 py-1 rounded border border-border bg-surface"
                defaultValue={(currentValue as string[]).join("\n")}
                placeholder={(defaultValue as string[]).join("\n")}
                onChange={(e) => {
                  const lines = e.currentTarget.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  onStringArray(fieldKey, lines);
                }}
              />
            ) : isString ? (
              <input
                type="text"
                className="w-full text-sm px-2 py-1 rounded border border-border bg-surface"
                defaultValue={String(currentValue)}
                placeholder={String(defaultValue)}
                onChange={(e) =>
                  onString(fieldKey, e.currentTarget.value || null)
                }
              />
            ) : (
              <input
                type="number"
                step="any"
                className="w-full text-sm px-2 py-1 rounded border border-border bg-surface font-mono"
                defaultValue={
                  overrideValue == null ? "" : String(overrideValue)
                }
                placeholder={String(defaultValue)}
                onChange={(e) => {
                  const raw = e.currentTarget.value.trim();
                  if (raw === "") {
                    onNumber(fieldKey, null);
                    return;
                  }
                  const parsed = Number(raw);
                  onNumber(fieldKey, Number.isNaN(parsed) ? null : parsed);
                }}
              />
            )}
            <div className="text-[10px] text-muted mt-0.5">
              Default:{" "}
              <code className="bg-surface-2 px-1 rounded">
                {isArray
                  ? `[${(defaultValue as string[])
                      .slice(0, 2)
                      .map((t) => `"${t}"`)
                      .join(", ")}${(defaultValue as string[]).length > 2 ? ", …" : ""}]`
                  : String(defaultValue)}
              </code>
              {groupKey === "escalation" && fieldKey === "escalate_on_pillar"
                ? " (accepts red or amber)"
                : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
