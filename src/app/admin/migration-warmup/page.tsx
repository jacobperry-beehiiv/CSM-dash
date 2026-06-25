"use client";

import { useEffect, useState } from "react";
import {
  DEFAULTS,
  type MigrationOverrides,
} from "@/lib/engines/migration-warmup/overrides";

/**
 * /admin/migration-warmup — tune the engine's decision knobs.
 *
 * Lets the team change the open-rate threshold (currently 30%), the
 * approach multipliers (standard/conservative/aggressive), and the
 * 52-week safety bound without a code edit + redeploy. Other knobs
 * (tier boundaries, rounding bands) stay in config.json — those are
 * deep algorithm shape, not a settings-level knob.
 *
 * The page renders defaults inline so an admin can see exactly what
 * each input falls back to when cleared, and a small explainer of
 * which knob does what.
 */

interface ApiResponse {
  overrides: MigrationOverrides;
  defaults: typeof DEFAULTS;
}

type Approach = "standard" | "conservative" | "aggressive";

interface Form {
  open_rate_threshold: string;
  multiplier_standard: string;
  multiplier_conservative: string;
  multiplier_aggressive: string;
  max_weeks: string;
}

const EMPTY_FORM: Form = {
  open_rate_threshold: "",
  multiplier_standard: "",
  multiplier_conservative: "",
  multiplier_aggressive: "",
  max_weeks: "",
};

function formFromOverrides(o: MigrationOverrides): Form {
  return {
    open_rate_threshold:
      o.open_rate_conservative_threshold !== undefined
        ? String(o.open_rate_conservative_threshold)
        : "",
    multiplier_standard:
      o.approach_multipliers?.standard !== undefined
        ? String(o.approach_multipliers.standard)
        : "",
    multiplier_conservative:
      o.approach_multipliers?.conservative !== undefined
        ? String(o.approach_multipliers.conservative)
        : "",
    multiplier_aggressive:
      o.approach_multipliers?.aggressive !== undefined
        ? String(o.approach_multipliers.aggressive)
        : "",
    max_weeks: o.max_weeks !== undefined ? String(o.max_weeks) : "",
  };
}

function formToOverrides(f: Form): MigrationOverrides {
  const out: MigrationOverrides = {};
  const t = Number(f.open_rate_threshold);
  if (f.open_rate_threshold.trim() !== "" && !Number.isNaN(t)) {
    out.open_rate_conservative_threshold = t;
  }
  const mult: Partial<Record<Approach, number>> = {};
  for (const k of ["standard", "conservative", "aggressive"] as const) {
    const v = f[`multiplier_${k}` as const];
    const n = Number(v);
    if (v.trim() !== "" && !Number.isNaN(n)) mult[k] = n;
  }
  if (Object.keys(mult).length > 0) out.approach_multipliers = mult;
  const w = Number(f.max_weeks);
  if (f.max_weeks.trim() !== "" && Number.isInteger(w)) out.max_weeks = w;
  return out;
}

export default function MigrationWarmupAdminPage() {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saved, setSaved] = useState<Form>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [gateState, setGateState] = useState<"ok" | "denied">("ok");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/migration-overrides", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 403 || r.status === 401) {
          if (!cancelled) setGateState("denied");
          return null;
        }
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
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
    form.multiplier_standard !== saved.multiplier_standard ||
    form.multiplier_conservative !== saved.multiplier_conservative ||
    form.multiplier_aggressive !== saved.multiplier_aggressive ||
    form.max_weeks !== saved.max_weeks;

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
        throw new Error(
          ("error" in j && j.error) || `HTTP ${r.status}`
        );
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

  if (gateState === "denied") {
    return (
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 max-w-prose">
        <h2 className="text-lg font-semibold text-fg">Migration warm-up</h2>
        <p className="text-sm text-muted mt-2">Admin only.</p>
      </section>
    );
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
        </div>

        {loading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : (
          <>
            <Row
              label="Open-rate threshold for conservative pacing"
              description="A list with an open rate below this value gets the conservative approach (smaller batches, more weeks). 0.30 = 30%."
              defaultValue={DEFAULTS.open_rate_conservative_threshold}
            >
              <InputWithReset
                value={form.open_rate_threshold}
                placeholder={String(DEFAULTS.open_rate_conservative_threshold)}
                onChange={(v) =>
                  setForm((f) => ({ ...f, open_rate_threshold: v }))
                }
                onReset={() => resetField("open_rate_threshold")}
                inputProps={{ inputMode: "decimal", type: "number", min: 0, max: 1, step: 0.01 }}
                suffix="(0..1)"
              />
            </Row>

            <Row
              label="Approach multipliers"
              description="Applied to every per-import batch size before cap enforcement. Conservative shrinks batches (adds weeks); aggressive grows them (compresses)."
              defaultValue={`${DEFAULTS.approach_multipliers.standard} / ${DEFAULTS.approach_multipliers.conservative} / ${DEFAULTS.approach_multipliers.aggressive}`}
            >
              <div className="grid grid-cols-3 gap-3">
                <SmallField
                  label="Standard"
                  value={form.multiplier_standard}
                  placeholder={String(DEFAULTS.approach_multipliers.standard)}
                  onChange={(v) =>
                    setForm((f) => ({ ...f, multiplier_standard: v }))
                  }
                  onReset={() => resetField("multiplier_standard")}
                />
                <SmallField
                  label="Conservative"
                  value={form.multiplier_conservative}
                  placeholder={String(
                    DEFAULTS.approach_multipliers.conservative
                  )}
                  onChange={(v) =>
                    setForm((f) => ({ ...f, multiplier_conservative: v }))
                  }
                  onReset={() => resetField("multiplier_conservative")}
                />
                <SmallField
                  label="Aggressive"
                  value={form.multiplier_aggressive}
                  placeholder={String(DEFAULTS.approach_multipliers.aggressive)}
                  onChange={(v) =>
                    setForm((f) => ({ ...f, multiplier_aggressive: v }))
                  }
                  onReset={() => resetField("multiplier_aggressive")}
                />
              </div>
            </Row>

            <Row
              label="Max weeks (safety bound)"
              description="Engine throws if a schedule would exceed this many weeks. Trip-wire for impossible inputs (huge list on monthly cadence)."
              defaultValue={DEFAULTS.max_weeks}
            >
              <InputWithReset
                value={form.max_weeks}
                placeholder={String(DEFAULTS.max_weeks)}
                onChange={(v) => setForm((f) => ({ ...f, max_weeks: v }))}
                onReset={() => resetField("max_weeks")}
                inputProps={{ inputMode: "numeric", type: "number", min: 4, max: 200, step: 1 }}
                suffix="weeks"
              />
            </Row>

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
                title="Clear every field — your next save resets all overrides back to the bundled defaults."
              >
                Reset all to defaults
              </button>
            </div>

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
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onReset: () => void;
  suffix?: string;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-40 px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
        {...inputProps}
      />
      {suffix ? (
        <span className="text-[11px] text-muted">{suffix}</span>
      ) : null}
      {value.trim() !== "" ? (
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

function SmallField({
  label,
  value,
  placeholder,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  return (
    <div>
      <div className="text-[10px] text-muted mb-1">{label}</div>
      <input
        type="number"
        step="0.01"
        min={0}
        max={10}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {value.trim() !== "" ? (
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
