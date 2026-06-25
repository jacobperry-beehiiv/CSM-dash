"use client";

import { useEffect, useState } from "react";
import {
  DEFAULTS,
  type MigrationOverrides,
} from "@/lib/engines/migration-warmup/overrides";

/**
 * /settings/migration-warmup — tune the engine's decision knobs.
 *
 * Moved here from /admin/* so the surface is discoverable in the
 * regular settings sidebar; the SAVE side stays gated to super-admin
 * (the API route still requires isAdmin), so non-admin viewers see
 * read-only inputs.
 *
 * Knobs surfaced:
 *   • Open-rate threshold for conservative pacing (default 30%)
 *   • Approach batch-size percentages — standard / conservative /
 *     aggressive. Stored as the engine's 0..N multiplier; the UI
 *     displays them as percentages (75% etc.) since that's how the
 *     team reasons about them.
 *   • Global max-weeks safety bound (default 52)
 *   • Conservative-specific max-weeks cap (default = global). Lets
 *     the team say "a conservative schedule is allowed to drag, but
 *     never more than N weeks" without lowering the global trip-wire.
 */

interface ApiResponse {
  overrides: MigrationOverrides;
  defaults: typeof DEFAULTS;
}

type Approach = "standard" | "conservative" | "aggressive";

interface Form {
  open_rate_threshold: string;
  /** UI value is a percentage (75) but storage is a multiplier (0.75). */
  multiplier_standard_pct: string;
  multiplier_conservative_pct: string;
  multiplier_aggressive_pct: string;
  max_weeks: string;
  max_weeks_conservative: string;
}

const EMPTY_FORM: Form = {
  open_rate_threshold: "",
  multiplier_standard_pct: "",
  multiplier_conservative_pct: "",
  multiplier_aggressive_pct: "",
  max_weeks: "",
  max_weeks_conservative: "",
};

function multToPct(v: number | undefined): string {
  return v !== undefined ? String(Math.round(v * 100)) : "";
}
function pctToMult(pct: string): number | undefined {
  const n = Number(pct);
  if (pct.trim() === "" || !Number.isFinite(n)) return undefined;
  return Math.round(n) / 100;
}

function formFromOverrides(o: MigrationOverrides): Form {
  return {
    open_rate_threshold:
      o.open_rate_conservative_threshold !== undefined
        ? String(Math.round(o.open_rate_conservative_threshold * 100))
        : "",
    multiplier_standard_pct: multToPct(o.approach_multipliers?.standard),
    multiplier_conservative_pct: multToPct(
      o.approach_multipliers?.conservative
    ),
    multiplier_aggressive_pct: multToPct(o.approach_multipliers?.aggressive),
    max_weeks: o.max_weeks !== undefined ? String(o.max_weeks) : "",
    max_weeks_conservative:
      o.max_weeks_conservative !== undefined
        ? String(o.max_weeks_conservative)
        : "",
  };
}

function formToOverrides(f: Form): MigrationOverrides {
  const out: MigrationOverrides = {};
  // Open-rate threshold: stored as 0..1 float; UI is a percentage.
  if (f.open_rate_threshold.trim() !== "") {
    const pct = Number(f.open_rate_threshold);
    if (Number.isFinite(pct)) {
      out.open_rate_conservative_threshold = Math.max(0, Math.min(100, pct)) / 100;
    }
  }
  const mult: Partial<Record<Approach, number>> = {};
  const keys: Array<[Approach, keyof Form]> = [
    ["standard", "multiplier_standard_pct"],
    ["conservative", "multiplier_conservative_pct"],
    ["aggressive", "multiplier_aggressive_pct"],
  ];
  for (const [k, field] of keys) {
    const v = pctToMult(f[field]);
    if (v !== undefined) mult[k] = v;
  }
  if (Object.keys(mult).length > 0) out.approach_multipliers = mult;
  const w = Number(f.max_weeks);
  if (f.max_weeks.trim() !== "" && Number.isInteger(w)) out.max_weeks = w;
  const wc = Number(f.max_weeks_conservative);
  if (f.max_weeks_conservative.trim() !== "" && Number.isInteger(wc)) {
    out.max_weeks_conservative = wc;
  }
  return out;
}

export default function MigrationWarmupSettingsPage() {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saved, setSaved] = useState<Form>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Viewer is signed in + has access to the GET? Both admins and
   *  non-admins reach this page from the settings sidebar; the
   *  current API route returns 403 for non-admin so they get a
   *  read-only experience. */
  const [editable, setEditable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/migration-overrides", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 403 || r.status === 401) {
          // Not admin — show a read-only view using the bundled
          // defaults. The actual values stored in KV are not visible
          // to non-admins (the API hides them), but the defaults
          // ARE the active values unless an override was set, so
          // showing those is informative enough.
          if (!cancelled) setEditable(false);
          return null;
        }
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        if (!cancelled) setEditable(true);
        return (await r.json()) as ApiResponse;
      })
      .then((j) => {
        if (cancelled || !j) return;
        const next = formFromOverrides(j.overrides);
        setForm(next);
        setSaved(next);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    form.open_rate_threshold !== saved.open_rate_threshold ||
    form.multiplier_standard_pct !== saved.multiplier_standard_pct ||
    form.multiplier_conservative_pct !== saved.multiplier_conservative_pct ||
    form.multiplier_aggressive_pct !== saved.multiplier_aggressive_pct ||
    form.max_weeks !== saved.max_weeks ||
    form.max_weeks_conservative !== saved.max_weeks_conservative;

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch("/api/admin/migration-overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formToOverrides(form)),
      });
      const j = (await r.json().catch(() => ({}))) as
        | ApiResponse
        | { error?: string };
      if (!r.ok || !("overrides" in j)) {
        throw new Error(("error" in j && j.error) || `HTTP ${r.status}`);
      }
      const next = formFromOverrides(j.overrides);
      setForm(next);
      setSaved(next);
      setMessage(
        "Saved. Next migration plan generation will use the new values."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown");
    } finally {
      setBusy(false);
    }
  }

  function resetField(key: keyof Form) {
    setForm((f) => ({ ...f, [key]: "" }));
  }

  function resetAll() {
    setForm(EMPTY_FORM);
    setMessage(null);
    setError(null);
  }

  return (
    <div className="space-y-5">
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">
            Migration warm-up — algorithm knobs
          </h2>
          <p className="text-xs text-muted mt-1 max-w-prose">
            The values below control the most-tweakable decisions the
            warm-up engine makes. Leave a field blank to fall back to
            the reference default. Tier boundaries (Micro / Small /
            Medium / Large / Super Large) and rounding bands are not
            exposed here — those are deeper algorithm shape and live
            in <code className="font-mono">config.json</code>.
          </p>
          {!editable && !loading ? (
            <p className="text-[11px] text-muted mt-2 italic">
              Read-only — only super-admins can edit. The defaults
              below are also the active values when no override is set.
            </p>
          ) : null}
        </div>

        {loading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : (
          <>
            <Row
              label="Open-rate threshold for conservative pacing"
              description="A list with an open rate below this value gets the conservative approach (smaller batches, more weeks)."
              defaultValue={`${Math.round(DEFAULTS.open_rate_conservative_threshold * 100)}%`}
            >
              <InputWithReset
                value={form.open_rate_threshold}
                placeholder={String(
                  Math.round(DEFAULTS.open_rate_conservative_threshold * 100)
                )}
                onChange={(v) =>
                  setForm((f) => ({ ...f, open_rate_threshold: v }))
                }
                onReset={() => resetField("open_rate_threshold")}
                inputProps={{
                  inputMode: "numeric",
                  type: "number",
                  min: 0,
                  max: 100,
                  step: 1,
                }}
                suffix="%"
                disabled={!editable}
              />
            </Row>

            <Row
              label="Batch size — percent of standard"
              description="Applied to every per-import batch size before cap enforcement. Conservative shrinks batches (so more weeks); aggressive grows them (so fewer)."
              defaultValue={`${Math.round(DEFAULTS.approach_multipliers.standard * 100)}% / ${Math.round(DEFAULTS.approach_multipliers.conservative * 100)}% / ${Math.round(DEFAULTS.approach_multipliers.aggressive * 100)}%`}
            >
              <div className="grid grid-cols-3 gap-3">
                <SmallPctField
                  label="Standard"
                  value={form.multiplier_standard_pct}
                  placeholder={String(
                    Math.round(DEFAULTS.approach_multipliers.standard * 100)
                  )}
                  onChange={(v) =>
                    setForm((f) => ({ ...f, multiplier_standard_pct: v }))
                  }
                  onReset={() => resetField("multiplier_standard_pct")}
                  disabled={!editable}
                />
                <SmallPctField
                  label="Conservative"
                  value={form.multiplier_conservative_pct}
                  placeholder={String(
                    Math.round(
                      DEFAULTS.approach_multipliers.conservative * 100
                    )
                  )}
                  onChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      multiplier_conservative_pct: v,
                    }))
                  }
                  onReset={() => resetField("multiplier_conservative_pct")}
                  disabled={!editable}
                />
                <SmallPctField
                  label="Aggressive"
                  value={form.multiplier_aggressive_pct}
                  placeholder={String(
                    Math.round(DEFAULTS.approach_multipliers.aggressive * 100)
                  )}
                  onChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      multiplier_aggressive_pct: v,
                    }))
                  }
                  onReset={() => resetField("multiplier_aggressive_pct")}
                  disabled={!editable}
                />
              </div>
            </Row>

            <Row
              label="Max weeks for conservative"
              description="The conservative schedule is allowed to stretch this many weeks before the engine throws. Useful for capping how long a low-open-rate list is allowed to drag."
              defaultValue={`${DEFAULTS.max_weeks_conservative} weeks`}
            >
              <InputWithReset
                value={form.max_weeks_conservative}
                placeholder={String(DEFAULTS.max_weeks_conservative)}
                onChange={(v) =>
                  setForm((f) => ({ ...f, max_weeks_conservative: v }))
                }
                onReset={() => resetField("max_weeks_conservative")}
                inputProps={{
                  inputMode: "numeric",
                  type: "number",
                  min: 4,
                  max: 200,
                  step: 1,
                }}
                suffix="weeks"
                disabled={!editable}
              />
            </Row>

            <Row
              label="Max weeks — global safety bound"
              description="Engine throws if ANY schedule (standard / aggressive / conservative-when-the-conservative-cap-isn't-set) would exceed this. Trip-wire for impossible inputs."
              defaultValue={`${DEFAULTS.max_weeks} weeks`}
            >
              <InputWithReset
                value={form.max_weeks}
                placeholder={String(DEFAULTS.max_weeks)}
                onChange={(v) => setForm((f) => ({ ...f, max_weeks: v }))}
                onReset={() => resetField("max_weeks")}
                inputProps={{
                  inputMode: "numeric",
                  type: "number",
                  min: 4,
                  max: 200,
                  step: 1,
                }}
                suffix="weeks"
                disabled={!editable}
              />
            </Row>

            {editable ? (
              <div className="flex items-center gap-3 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || busy}
                  className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={resetAll}
                  disabled={busy}
                  className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50 ml-auto"
                  title="Clear every field — next save reverts every override back to the bundled defaults."
                >
                  Reset all to defaults
                </button>
              </div>
            ) : null}

            {message ? (
              <div className="text-xs text-emerald-700 dark:text-emerald-300">
                {message}
              </div>
            ) : null}
            {error ? (
              <div className="text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  description,
  defaultValue,
  children,
}: {
  label: string;
  description: string;
  defaultValue: string | number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="block text-xs font-medium text-muted">{label}</label>
        <span className="text-[10px] text-subtle font-mono">
          default: {defaultValue}
        </span>
      </div>
      {children}
      <p className="text-[11px] text-muted">{description}</p>
    </div>
  );
}

function InputWithReset({
  value,
  placeholder,
  onChange,
  onReset,
  suffix,
  inputProps,
  disabled,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onReset: () => void;
  suffix?: string;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-40 px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        {...inputProps}
      />
      {suffix ? (
        <span className="text-[11px] text-muted">{suffix}</span>
      ) : null}
      {!disabled && value.trim() !== "" ? (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-muted hover:text-fg underline"
        >
          use default
        </button>
      ) : null}
    </div>
  );
}

function SmallPctField({
  label,
  value,
  placeholder,
  onChange,
  onReset,
  disabled,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] text-muted mb-1">{label}</div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step="1"
          min={0}
          max={1000}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        />
        <span className="text-[11px] text-muted">%</span>
      </div>
      {!disabled && value.trim() !== "" ? (
        <button
          type="button"
          onClick={onReset}
          className="mt-1 text-[10px] text-muted hover:text-fg underline"
        >
          use default
        </button>
      ) : null}
    </div>
  );
}
