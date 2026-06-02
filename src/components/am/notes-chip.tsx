"use client";

import { useEffect, useState } from "react";
import type { CustomerSignal } from "@/lib/data/customer-signals";

/**
 * Tiny inline indicator + click target placed next to a company name
 * on the AM panels' rows. Surfaces "this account has N notes" (or
 * "+ note" when empty) and routes clicks to a caller-supplied
 * onExpand handler — typically the same row-toggle that the chevron
 * uses, so opening the chip naturally reveals the full CompanyNotes
 * editor that already lives inside CustomerDetailPanel.
 *
 * Per-row note count comes from /api/customer-signals?workspace_id=...
 * filtered to kind:note. Fetched lazily and cached per workspace_id
 * at the module level so the same Past Due / Approaching Enterprise
 * row that appears in multiple sub-tabs only fires one network call
 * per page session.
 *
 * Designed to be visually unobtrusive — same size + color register as
 * the existing OutreachStatusBadge / ProactiveStatusBadge chips, so
 * adding it doesn't bulk up the company column.
 */

interface Props {
  workspaceId: string | null | undefined;
  /** Called when the chip is clicked. Receivers normally toggle the
   *  row's expanded state so the embedded notes section becomes
   *  visible. */
  onClick: () => void;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expires: number; count: number }>();
const inFlight = new Map<string, Promise<number>>();

async function fetchCount(workspaceId: string): Promise<number> {
  const cached = cache.get(workspaceId);
  if (cached && cached.expires > Date.now()) return cached.count;
  const existing = inFlight.get(workspaceId);
  if (existing) return existing;
  const p = (async () => {
    try {
      const r = await fetch(
        `/api/customer-signals?workspace_id=${encodeURIComponent(workspaceId)}`,
        { cache: "no-store" }
      );
      if (!r.ok) return 0;
      const j = (await r.json()) as { signals?: CustomerSignal[] };
      const count = (j.signals ?? []).filter((s) => s.kind === "note").length;
      cache.set(workspaceId, { expires: Date.now() + CACHE_TTL_MS, count });
      return count;
    } catch {
      return 0;
    } finally {
      inFlight.delete(workspaceId);
    }
  })();
  inFlight.set(workspaceId, p);
  return p;
}

export function NotesChip({ workspaceId, onClick }: Props) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void fetchCount(workspaceId).then((n) => {
      if (!cancelled) setCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!workspaceId) return null;

  const label = count == null ? "📝" : count > 0 ? `📝 ${count}` : "+ note";

  return (
    <button
      type="button"
      onClick={(e) => {
        // Row-level click handlers expand the row on bare clicks; the
        // chip itself triggers expansion too, but we still stop
        // propagation so the row's own click handler doesn't fire
        // *additionally* and toggle the expansion off again.
        e.stopPropagation();
        onClick();
      }}
      title={
        count == null
          ? "Open notes for this account"
          : count > 0
            ? `View / add notes (${count} existing)`
            : "Add the first note for this account"
      }
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-border bg-canvas/40 text-muted hover:text-fg hover:border-border-strong"
    >
      {label}
    </button>
  );
}
