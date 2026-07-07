"use client";

import { useMemo, useState } from "react";
import type {
  FieldMeta,
  WinsConfig,
} from "@/lib/data/wins-config-types";
import { WINS_CONFIG_META } from "@/lib/data/wins-config-types";

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

interface Props {
  defaults: WinsConfig;
  initialOverrides: DeepPartial<WinsConfig>;
  meta: { updated_at: string | null; updated_by: string | null };
}

/**
 * Per-rule threshold editor. One card per rule; each field renders
 * as `<input type="number">` with a placeholder showing the default.
 * The current-value / default-value split is explicit so an admin
 * can eyeball drift.
 *
 * Save writes the full overrides object; server strips any field
 * matching the default so a future default change rolls forward.
 */
export function WinsConfigEditor({ defaults, initialOverrides, meta }: Props) {
  const [draft, setDraft] = useState<DeepPartial<WinsConfig>>(initialOverrides);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    return JSON.stringify(draft) !== JSON.stringify(initialOverrides);
  }, [draft, initialOverrides]);

  function setField(ruleKey: keyof WinsConfig, fieldKey: string, value: number | null) {
    setDraft((prev) => {
      const next: DeepPartial<WinsConfig> = { ...prev };
      const rule = { ...((next[ruleKey] ?? {}) as Record<string, number>) };
      if (value == null || Number.isNaN(value)) {
        delete rule[fieldKey];
      } else {
        rule[fieldKey] = value;
      }
      if (Object.keys(rule).length === 0) {
        delete next[ruleKey];
      } else {
        next[ruleKey] = rule as (DeepPartial<WinsConfig>)[typeof ruleKey];
      }
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/settings/wins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: draft }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setDraft(body.overrides ?? {});
      setMessage("Saved. Next detection run will use the new thresholds.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  function resetAll() {
    setDraft({});
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted">
          {meta.updated_at ? (
            <>
              Last saved {new Date(meta.updated_at).toLocaleString()}
              {meta.updated_by ? ` by ${meta.updated_by}` : null}
            </>
          ) : (
            <em>No overrides yet — running against shipped defaults.</em>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetAll}
            disabled={saving || Object.keys(draft).length === 0}
            className="text-xs px-2.5 py-1.5 border border-border rounded-md text-muted hover:text-fg disabled:opacity-60"
            title="Clear every override — reverts every field to the shipped default on save."
          >
            Reset all to defaults
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="text-sm px-3 py-1.5 rounded-md border border-border bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "No changes"}
          </button>
        </div>
      </div>

      {message ? (
        <div className="text-xs bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 rounded-md px-3 py-2">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="text-xs bg-red-50 dark:bg-red-500/10 border border-red-500/30 text-red-800 dark:text-red-300 rounded-md px-3 py-2">
          {error}
        </div>
      ) : null}

      {WINS_CONFIG_META.map((rule) => {
        const ruleDefaults = defaults[rule.key] as unknown as Record<string, number>;
        const ruleDraft = (draft[rule.key] ?? {}) as Record<string, number>;
        return (
          <section
            key={rule.key}
            className="bg-surface rounded-md border border-border p-4 space-y-3"
          >
            <div>
              <h2 className="text-sm font-semibold text-fg">{rule.label}</h2>
              <p className="text-xs text-muted mt-0.5">{rule.description}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {rule.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  defaultValue={ruleDefaults[field.key]}
                  currentValue={ruleDraft[field.key] ?? null}
                  onChange={(v) => setField(rule.key, field.key, v)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function FieldRow({
  field,
  defaultValue,
  currentValue,
  onChange,
}: {
  field: FieldMeta;
  defaultValue: number;
  currentValue: number | null;
  onChange: (value: number | null) => void;
}) {
  const hasOverride = currentValue != null;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-fg font-medium flex items-center gap-2">
        {field.label}
        {hasOverride ? (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent-soft text-accent border border-accent/30">
            overridden
          </span>
        ) : null}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step={field.step}
          min={field.min}
          max={field.max}
          value={currentValue ?? ""}
          placeholder={formatPlaceholder(defaultValue, field.unit)}
          onChange={(e) => {
            const raw = e.target.value.trim();
            onChange(raw === "" ? null : Number(raw));
          }}
          className="w-32 px-2 py-1 border border-border-strong rounded-md bg-surface text-fg text-sm"
        />
        <span className="text-[11px] text-subtle">
          default {formatPlaceholder(defaultValue, field.unit)}
        </span>
      </div>
      <span className="text-[11px] text-muted">{field.hint}</span>
    </label>
  );
}

function formatPlaceholder(value: number, unit: FieldMeta["unit"]): string {
  switch (unit) {
    case "ratio":
      return value.toFixed(3);
    case "pct_absolute":
      return value.toFixed(3);
    case "days":
    case "weeks":
      return `${value}`;
    case "count":
      return value.toLocaleString();
    default:
      return String(value);
  }
}
