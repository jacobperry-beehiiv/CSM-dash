"use client";

import { useEffect, useState } from "react";
import {
  FONT_OPTIONS,
  type FontKey,
  type Personalization,
} from "@/lib/data/personalization-types";

/**
 * /settings/personalize — per-user dashboard customization.
 *
 * Gated server-side via the /api/personalization GET 403 path; this
 * page just surfaces that gate as a friendly explainer pointing at
 * /settings/gmail. The state model:
 *
 *   - Load current value on mount via GET.
 *   - Local form state mirrors the saved value, with `dirty` to gate
 *     the Save button + a Reset button that snaps back to the last
 *     saved state.
 *   - PUT on Save returns the sanitized stored value, which we then
 *     mirror into local state so any server-side normalizations
 *     (lower-cased hex, trimmed name) appear immediately.
 *
 * Live preview: we don't try to mutate the document's `--accent` etc
 * inline — the user has to Save to see the change apply, because the
 * PersonalizationProvider reads from the server-side initial value.
 * A reload after Save lands the new theme.
 */

interface Form {
  dashboard_name: string;
  accent_color: string;
  font_key: FontKey;
  logo_url: string;
}

const EMPTY_FORM: Form = {
  dashboard_name: "",
  accent_color: "",
  font_key: "default",
  logo_url: "",
};

export default function PersonalizePage() {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saved, setSaved] = useState<Form>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateState, setGateState] = useState<
    "ok" | "ineligible" | "disabled"
  >("ok");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/personalization", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 403) {
          const j = (await r.json().catch(() => ({}))) as {
            disabled?: boolean;
            ineligible?: boolean;
          };
          if (!cancelled) {
            setGateState(j.disabled ? "disabled" : "ineligible");
          }
          return null;
        }
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as Personalization;
      })
      .then((p) => {
        if (cancelled || !p) return;
        const next: Form = {
          dashboard_name: p.dashboard_name ?? "",
          accent_color: p.accent_color ?? "",
          font_key: (p.font_key as FontKey) ?? "default",
          logo_url: p.logo_url ?? "",
        };
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
    form.dashboard_name !== saved.dashboard_name ||
    form.accent_color !== saved.accent_color ||
    form.font_key !== saved.font_key ||
    form.logo_url !== saved.logo_url;

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch("/api/personalization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form satisfies Personalization),
      });
      const j = (await r.json().catch(() => ({}))) as Personalization & {
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const next: Form = {
        dashboard_name: j.dashboard_name ?? "",
        accent_color: j.accent_color ?? "",
        font_key: (j.font_key as FontKey) ?? "default",
        logo_url: j.logo_url ?? "",
      };
      setForm(next);
      setSaved(next);
      setMessage(
        "Saved. Refresh any open dashboard tabs to see the new theme apply."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown");
    } finally {
      setBusy(false);
    }
  }

  function resetForm() {
    setForm(saved);
    setMessage(null);
    setError(null);
  }

  function clearAll() {
    setForm(EMPTY_FORM);
    setMessage(null);
    setError(null);
  }

  if (gateState === "ineligible") {
    return (
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 max-w-prose">
        <h2 className="text-lg font-semibold text-fg">
          Personalize the dashboard
        </h2>
        <p className="text-sm text-muted mt-2">
          This page is for CSMs with a Gmail account connected. Connect
          at{" "}
          <a
            href="/settings/gmail"
            className="text-accent hover:underline font-medium"
          >
            /settings/gmail
          </a>
          , then come back here to set your dashboard name, accent
          color, font, and logo.
        </p>
        <p className="text-xs text-muted mt-3">
          Non-CSM viewers (admins, sales, demo accounts) see the
          dashboard&rsquo;s default look — your customizations only
          render for you.
        </p>
      </section>
    );
  }

  if (gateState === "disabled") {
    return (
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 max-w-prose">
        <h2 className="text-lg font-semibold text-fg">
          Personalize the dashboard
        </h2>
        <p className="text-sm text-muted mt-2">
          Personalization is currently restricted by your super-admin.
          Your email isn&rsquo;t on the allow list yet.
        </p>
        <p className="text-xs text-muted mt-3">
          If you need access, ask the super-admin to add you at{" "}
          <code className="font-mono">/admin/flags</code>.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">
            Personalize the dashboard
          </h2>
          <p className="text-xs text-muted mt-1 max-w-prose">
            Customizations apply only to your view of the dashboard.
            Other viewers (and you while &ldquo;Business Mode&rdquo; is
            on in the header) see the default look.
          </p>
        </div>

        {loading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : (
          <>
            <Row label="Dashboard name">
              <input
                type="text"
                value={form.dashboard_name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, dashboard_name: e.target.value }))
                }
                placeholder="CSM Mission Control"
                maxLength={60}
                className="w-full px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <p className="text-[11px] text-muted">
                Shown next to the logo in the header + as the browser
                tab title. Up to 60 characters.
              </p>
            </Row>

            <Row label="Accent color">
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={form.accent_color || "#7787e3"}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, accent_color: e.target.value }))
                  }
                  className="h-9 w-12 cursor-pointer rounded border border-border bg-canvas"
                  aria-label="Pick accent color"
                />
                <input
                  type="text"
                  value={form.accent_color}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, accent_color: e.target.value }))
                  }
                  placeholder="#7787e3"
                  className="w-32 px-3 py-2 text-sm font-mono bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                />
                {form.accent_color ? (
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, accent_color: "" }))}
                    className="text-xs text-muted hover:text-fg underline"
                  >
                    use default
                  </button>
                ) : null}
              </div>
              <p className="text-[11px] text-muted">
                Drives the &ldquo;Send&rdquo; / &ldquo;Save&rdquo; /
                &ldquo;active tab&rdquo; buttons + any other surface
                that reads <code className="font-mono">--accent</code>.
              </p>
            </Row>

            <Row label="Font">
              <select
                value={form.font_key}
                onChange={(e) =>
                  setForm((f) => ({ ...f, font_key: e.target.value as FontKey }))
                }
                className="w-64 px-3 py-2 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {FONT_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted">
                Body font family. Each option is preloaded from Google
                Fonts so the swap is instant once your save applies.
              </p>
            </Row>

            <Row label="Logo URL">
              <input
                type="url"
                value={form.logo_url}
                onChange={(e) =>
                  setForm((f) => ({ ...f, logo_url: e.target.value }))
                }
                placeholder="https://your-cdn.example.com/logo.png"
                className="w-full px-3 py-2 text-sm font-mono bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <p className="text-[11px] text-muted">
                Public HTTPS URL to a small square-ish image — replaces
                the beehiiv mark in the top-left. Paste an existing
                hosted image; uploads aren&rsquo;t supported in this
                pass.
              </p>
            </Row>

            <div className="flex items-center gap-3 pt-2 border-t border-border">
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
                onClick={resetForm}
                disabled={!dirty || busy}
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
              >
                Discard changes
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={busy}
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50 ml-auto"
                title="Clear every field — your next save resets all overrides back to the default look."
              >
                Reset to defaults
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

      <section className="bg-surface rounded-xl border border-border shadow-card p-5 text-xs text-muted space-y-2 max-w-prose">
        <p>
          <strong className="text-fg">Business Mode.</strong> Click the
          &ldquo;Business Mode&rdquo; pill in the header (top-right) to
          temporarily hide your customizations and show the default
          look. The setting is per-device (localStorage) and
          intentionally non-persistent across reloads-after-clear-data
          — use it when screen-sharing a customer-facing demo.
        </p>
        <p>
          <strong className="text-fg">Who sees this.</strong> Only you.
          Customizations are scoped to your email; other viewers see
          the default look. The page is gated to CSMs with Gmail
          connected — non-CSMs land on the explainer above.
        </p>
      </section>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted">{label}</label>
      {children}
    </div>
  );
}
