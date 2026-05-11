"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";

interface Props {
  customer: Customer;
}

const OPTIONS: Array<{ value: "month" | "annual"; label: string }> = [
  { value: "month", label: "Monthly" },
  { value: "annual", label: "Annual" },
];

/**
 * Per-customer cadence override. Writes to data/customer-overrides.json
 * server-side; the loadCustomers cache is busted on save so the next page
 * load reflects the new cadence everywhere it matters (price merge tags,
 * renewals tab, AM dashboard, etc.).
 */
export function CadenceToggle({ customer }: Props) {
  const [interval, setInterval] = useState<"month" | "annual">(
    (customer.interval ?? "").toLowerCase() === "month" ? "month" : "annual"
  );
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  if (!customer.workspace_id) return null;

  async function pick(next: "month" | "annual") {
    if (busy || next === interval) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/customer-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: customer.workspace_id,
          interval: next,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setInterval(next);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted">Billing cadence:</span>
      <div className="inline-flex rounded-md border border-border-strong bg-surface text-xs overflow-hidden">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => pick(o.value)}
            disabled={busy}
            className={`px-3 py-1 ${
              interval === o.value
                ? "bg-accent text-accent-fg"
                : "text-muted hover:bg-canvas"
            } disabled:opacity-50`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {busy ? (
        <span className="text-xs text-subtle">saving…</span>
      ) : savedAt ? (
        <span className="text-xs text-emerald-700 dark:text-emerald-300">saved</span>
      ) : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
