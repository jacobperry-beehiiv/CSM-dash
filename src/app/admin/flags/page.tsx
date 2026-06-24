"use client";

import { useEffect, useState } from "react";
import {
  FEATURE_METADATA,
  type AdminFlags,
  type FeatureGate,
  type FeatureId,
} from "@/lib/data/admin-flags-types";

/**
 * /admin/flags — toggle per-feature allow lists.
 *
 * Each feature renders as a card with a "Restrict to specific CSMs"
 * toggle. When restricted, a multi-select picker shows every CSM
 * whose Gmail is connected (the only people who could realistically
 * use personalization anyway). When unrestricted, the picker is
 * collapsed and every eligible CSM gets the feature.
 *
 * Save sends the full AdminFlags object to PUT /api/admin/flags
 * and the server normalizes + persists.
 */

interface EligibleCsm {
  email: string;
  name: string;
}

interface ApiResponse {
  flags: AdminFlags;
  eligible_csms: EligibleCsm[];
}

export default function FlagsPage() {
  const [flags, setFlags] = useState<AdminFlags | null>(null);
  const [saved, setSaved] = useState<AdminFlags | null>(null);
  const [eligible, setEligible] = useState<EligibleCsm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/flags", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as ApiResponse;
      })
      .then((j) => {
        if (cancelled) return;
        setFlags(j.flags);
        setSaved(j.flags);
        setEligible(j.eligible_csms);
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
    flags !== null &&
    saved !== null &&
    JSON.stringify(flags) !== JSON.stringify(saved);

  function updateGate(id: FeatureId, next: FeatureGate) {
    setFlags((prev) =>
      prev
        ? {
            ...prev,
            features: { ...prev.features, [id]: next },
          }
        : prev
    );
    setMessage(null);
  }

  async function save() {
    if (!flags) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fetch("/api/admin/flags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flags),
      });
      const j = (await r.json().catch(() => ({}))) as {
        flags?: AdminFlags;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (j.flags) {
        setFlags(j.flags);
        setSaved(j.flags);
      }
      setMessage(
        "Saved. Changes take effect on the next request — open tabs may need a reload."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown");
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setFlags(saved);
    setError(null);
    setMessage(null);
  }

  if (loading) {
    return <div className="text-sm text-muted">Loading flags…</div>;
  }

  if (error && !flags) {
    return (
      <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
        {error}
      </div>
    );
  }

  if (!flags) return null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-fg">Feature flags</h2>
        <p className="text-xs text-muted mt-1 max-w-prose">
          Per-feature allow lists. Restrict a feature to specific CSMs
          when you want a controlled rollout; leave unrestricted to
          enable for everyone who passes the feature&rsquo;s own
          eligibility check.
        </p>
      </div>

      {FEATURE_METADATA.map((meta) => {
        const gate = flags.features[meta.id];
        return (
          <section
            key={meta.id}
            className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-fg">
                  {meta.label}
                </h3>
                <p className="text-xs text-muted mt-1 max-w-prose">
                  {meta.description}
                </p>
                {meta.eligibility_note ? (
                  <p className="text-[11px] text-muted mt-1 max-w-prose italic">
                    {meta.eligibility_note}
                  </p>
                ) : null}
              </div>
              <label className="flex items-center gap-2 text-xs flex-shrink-0 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={gate.restricted}
                  onChange={(e) =>
                    updateGate(meta.id, {
                      ...gate,
                      restricted: e.target.checked,
                    })
                  }
                  className="h-4 w-4 rounded border-border-strong"
                />
                Restrict to specific CSMs
              </label>
            </div>

            {gate.restricted ? (
              <CsmPicker
                eligible={eligible}
                selected={gate.allowed_emails}
                onChange={(next) =>
                  updateGate(meta.id, { ...gate, allowed_emails: next })
                }
              />
            ) : (
              <div className="text-xs text-muted">
                Unrestricted — every eligible CSM gets this feature.
              </div>
            )}
          </section>
        );
      })}

      <div className="flex items-center gap-3 sticky bottom-4 bg-canvas/95 backdrop-blur border border-border rounded-lg px-4 py-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={discard}
          disabled={!dirty || busy}
          className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
        >
          Discard
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

/** Multi-select picker — every eligible CSM rendered as a checkable
 *  row. Search input narrows the list. */
function CsmPicker({
  eligible,
  selected,
  onChange,
}: {
  eligible: EligibleCsm[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selectedSet = new Set(selected.map((e) => e.toLowerCase()));

  function toggle(email: string) {
    const lower = email.toLowerCase();
    if (selectedSet.has(lower)) {
      onChange(selected.filter((e) => e.toLowerCase() !== lower));
    } else {
      onChange([...selected, lower]);
    }
  }

  const filtered = eligible.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return c.email.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
  });

  if (eligible.length === 0) {
    return (
      <div className="text-xs text-muted bg-canvas border border-border rounded-md px-3 py-2">
        No CSMs with Gmail connected yet — connect one at{" "}
        <code className="font-mono">/settings/gmail</code>, then come
        back here to allow-list them.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter CSMs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-1.5 text-sm bg-canvas border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <span className="text-xs text-muted whitespace-nowrap">
          {selected.length} of {eligible.length} allowed
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto border border-border rounded-md bg-canvas divide-y divide-border">
        {filtered.map((c) => {
          const checked = selectedSet.has(c.email.toLowerCase());
          return (
            <label
              key={c.email}
              className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2 cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(c.email)}
                className="h-4 w-4 rounded border-border-strong"
              />
              <span className="flex-1 min-w-0">
                <span className="block text-fg font-medium">{c.name}</span>
                <span className="block text-[11px] text-muted font-mono break-words">
                  {c.email}
                </span>
              </span>
            </label>
          );
        })}
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted">
            No CSMs match &ldquo;{search}&rdquo;.
          </div>
        ) : null}
      </div>
    </div>
  );
}
