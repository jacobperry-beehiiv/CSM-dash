"use client";

import { useEffect, useState } from "react";
import type { RiskFlag, RiskFlagCode } from "@/lib/types";

interface Props {
  workspaceId: string | null | undefined;
  flags: RiskFlag[];
}

const FLAG_COLORS: Record<string, string> = {
  A: "bg-blue-100 text-blue-800 dark:text-blue-300",
  B: "bg-indigo-100 text-indigo-800",
  C: "bg-amber-100 text-amber-800 dark:text-amber-300",
  D: "bg-red-100 text-red-800 dark:text-red-300",
  E: "bg-orange-100 text-orange-800",
  F: "bg-purple-100 text-purple-800",
  G: "bg-rose-100 text-rose-800",
  H: "bg-orange-100 text-orange-800",
};

export function FlagResolutionCheckboxes({ workspaceId, flags }: Props) {
  const [resolvedSet, setResolvedSet] = useState<Set<RiskFlagCode>>(new Set());
  const [pending, setPending] = useState<Set<RiskFlagCode>>(new Set());

  // Hydrate initial state from the resolutions store. The engine has already
  // filtered resolved flags out of the visible list, so this fetch is mostly
  // belt-and-suspenders for the case where the same panel stays open across
  // toggles.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    fetch("/api/flag-resolutions")
      .then((r) => r.json())
      .then((map: Record<string, Record<string, unknown>>) => {
        if (cancelled) return;
        const next = new Set<RiskFlagCode>();
        for (const code of Object.keys(map[workspaceId] ?? {})) {
          next.add(code as RiskFlagCode);
        }
        setResolvedSet(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function toggle(code: RiskFlagCode, value: boolean) {
    if (!workspaceId) return;
    setPending((prev) => new Set(prev).add(code));
    try {
      const res = await fetch("/api/flag-resolutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          flag_code: code,
          resolved: value,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResolvedSet((prev) => {
        const next = new Set(prev);
        if (value) next.add(code);
        else next.delete(code);
        return next;
      });
    } catch (e) {
      console.error("Failed to toggle resolution:", e);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(code);
        return next;
      });
    }
  }

  if (!workspaceId || flags.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
        Mark resolved (filters this customer out of future runs)
      </h4>
      <ul className="space-y-1.5">
        {flags.map((f) => {
          const resolved = resolvedSet.has(f.code);
          const isPending = pending.has(f.code);
          return (
            <li key={f.code} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={resolved}
                disabled={isPending}
                onChange={(e) => toggle(f.code, e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-border-strong cursor-pointer disabled:opacity-50"
                aria-label={`Mark ${f.code} resolved`}
              />
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold mr-1 ${
                  FLAG_COLORS[f.code] ?? "bg-surface-2"
                }`}
              >
                {f.code}
              </span>
              <span
                className={`flex-1 break-words ${
                  resolved ? "line-through text-subtle" : "text-fg"
                }`}
              >
                {f.label} — {f.detail}
              </span>
              {isPending ? (
                <span className="text-xs text-subtle">saving…</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] text-muted">
        Reach out to the customer, then check the box. The flag is hidden from
        all future at-risk runs until you uncheck it.
      </p>
    </div>
  );
}
