"use client";

import { useState } from "react";
import type { ZendeskSummary } from "@/lib/data/zendesk-tickets";
import { fmtDate } from "./format";

/**
 * Compact ticket-signal chip for the Approaching Enterprise +
 * Enterprise Only tables. Renders as:
 *   🎫 12 · 3 high · 1 urgent
 * — with the high/urgent segments colored red/amber when non-zero.
 * Clicking opens a mini-popover with the recent-tickets sample from
 * the overlay (one line per ticket, subject + priority + date +
 * external link to the ticket in Zendesk).
 *
 * The summary is a prop rather than a fetch — panels load the whole
 * overlay once on mount and pass row-shaped summaries in, so
 * scrolling a 200-row table doesn't produce 200 API calls.
 *
 * When `summary` is null the workspace is off the overlay (not
 * scanned yet, or the sweep hasn't picked it up). Render a subtle
 * "—" so the column doesn't look broken.
 */

interface Props {
  summary: ZendeskSummary | null;
  /** Optional override for the Zendesk portal URL. The company-page
   *  link on the customer profile shows the same shape; extract when
   *  we've got two callers wanting to point at a custom subdomain. */
  zendeskBaseUrl?: string;
}

const DEFAULT_ZENDESK_BASE = "https://beehiivhelp.zendesk.com";

export function ZendeskTicketsChip({
  summary,
  zendeskBaseUrl = DEFAULT_ZENDESK_BASE,
}: Props) {
  const [open, setOpen] = useState(false);
  if (!summary) {
    return <span className="text-subtle text-xs">—</span>;
  }
  const {
    total_30d,
    high_priority_30d,
    urgent_30d,
    latest_created_at,
    recent,
  } = summary;
  // No tickets in the window is a positive signal — render a muted
  // "0 · 30d" chip so the reader can tell the sweep ran and the
  // account is quiet, distinct from the "not scanned" fallback.
  if (total_30d === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] text-muted"
        title="No Zendesk tickets in the last 30 days."
      >
        🎫 <span>0</span>
      </span>
    );
  }
  const hasHigh = high_priority_30d > 0;
  const hasUrgent = urgent_30d > 0;
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          latest_created_at
            ? `Latest ticket ${fmtDate(latest_created_at)}. Click for details.`
            : "Click for details."
        }
        className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ${
          hasUrgent
            ? "border-red-400 dark:border-red-500/60 bg-red-50 dark:bg-red-500/10 text-red-900 dark:text-red-100"
            : hasHigh
              ? "border-amber-400 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-100"
              : "border-border bg-surface text-fg hover:bg-canvas"
        }`}
      >
        <span>🎫</span>
        <span className="font-semibold">{total_30d}</span>
        {hasHigh || hasUrgent ? (
          <>
            <span className="opacity-60">·</span>
            {hasUrgent ? (
              <span className="font-medium">
                {urgent_30d} urgent
              </span>
            ) : (
              <span className="font-medium">
                {high_priority_30d} high
              </span>
            )}
          </>
        ) : null}
      </button>
      {open ? (
        <div
          className="absolute z-20 right-0 top-full mt-1 w-80 rounded-md border border-border bg-surface shadow-lg p-2 text-xs"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="flex items-center justify-between mb-1 pb-1 border-b border-border/60">
            <div className="font-semibold text-fg">
              Zendesk tickets (30d)
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted hover:text-fg text-[10px]"
            >
              close
            </button>
          </div>
          <div className="text-[10px] text-muted mb-1.5">
            {total_30d} total · {high_priority_30d} high · {urgent_30d}{" "}
            urgent
          </div>
          {recent.length === 0 ? (
            <div className="text-muted italic text-[11px]">
              No recent tickets in the sample.
            </div>
          ) : (
            <ul className="space-y-1 max-h-64 overflow-y-auto">
              {recent.map((t) => (
                <li key={t.zendesk_id} className="border-b border-border/40 pb-1 last:border-0">
                  <a
                    href={`${zendeskBaseUrl}/agent/tickets/${t.zendesk_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block group"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-fg group-hover:underline truncate">
                        {t.subject ?? `Ticket #${t.zendesk_id}`}
                      </span>
                      {t.priority === "urgent" ? (
                        <span className="text-[9px] uppercase font-bold text-red-700 dark:text-red-300">
                          urgent
                        </span>
                      ) : t.priority === "high" ? (
                        <span className="text-[9px] uppercase font-bold text-amber-700 dark:text-amber-300">
                          high
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[10px] text-muted mt-0.5">
                      {fmtDate(t.created_at)}
                      {t.status ? ` · ${t.status}` : null}
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
