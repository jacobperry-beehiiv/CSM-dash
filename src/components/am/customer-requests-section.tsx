"use client";

import { useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { CollapsibleSection } from "../collapsible-section";
import { fmtDate } from "../format";
import { OutreachModal } from "../outreach-modal";
import type {
  EnterpriseRequestDerivedState,
  EnterpriseRequestRow,
  NotifiedEntry,
} from "@/lib/data/enterprise-requests-types";
import { estimateToTShirt } from "@/lib/data/enterprise-requests-types";

/**
 * Requests section on the customer detail panel.
 *
 * Reads the pre-aggregated snapshot via `/api/enterprise-requests
 * ?workspace_id=...` on mount. Grouped by derived_state, newest
 * first within group. Per-row [Draft outreach] button on Live rows
 * (opens the OutreachModal with a feature-shipped merge context) +
 * a Notified checkbox that POSTs to `/api/enterprise-requests/notify`.
 *
 * The Draft-outreach path is a soft "engagement" signal — clicking
 * stamps drafted_at even if the CSM closes the modal without
 * sending. Notified is the strong signal that removes the row from
 * the weekly digest.
 *
 * Fail-open: on a network error the section shows a muted "couldn't
 * load" line, matching the CustomerNewsSection pattern.
 */

interface Props {
  /** Full Customer record — passed so the Draft outreach button can
   *  hand the same object to the section-owned OutreachModal without
   *  a second fetch. `workspaceId` is derived from
   *  `customer.workspace_id` for the API call. */
  customer: Customer;
  /** Feature-flag gate — threaded from the parent so we can hide the
   *  whole section without unmounting mid-fetch. When false, we
   *  render nothing. */
  enabled: boolean;
}

interface Row extends EnterpriseRequestRow {
  notified: NotifiedEntry;
}

interface ApiResponse {
  workspace_id: string;
  rows: Row[];
  outstanding: number;
  delivered: number;
  last_synced_at: string;
}

/** Order the state buckets so the render reads top-to-bottom in
 *  "what needs attention" order — Live-possibly-in-beta first (the
 *  CSM's outreach queue is here), then Live, then Open work, then
 *  the archived Not-planned bucket. */
const STATE_ORDER: EnterpriseRequestDerivedState[] = [
  "Live, possibly in beta",
  "Live",
  "In progress",
  "Open",
  "Not planned",
];

const STATE_BADGE_CLASS: Record<EnterpriseRequestDerivedState, string> = {
  Live:
    "border-emerald-400 dark:border-emerald-500/60 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  "Live, possibly in beta":
    "border-amber-400 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-200",
  "In progress":
    "border-blue-400 dark:border-blue-500/60 bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-200",
  Open:
    "border-border bg-surface text-fg",
  "Not planned":
    "border-slate-400 dark:border-slate-500/40 bg-slate-100 dark:bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

export function CustomerRequestsSection({
  customer,
  enabled,
}: Props) {
  const workspaceId = customer.workspace_id;
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Row currently being drafted-against — powers the section-owned
  // OutreachModal so we don't need to plumb an opener callback all
  // the way up to the customer-table client component. The Draft
  // outreach button opens the modal; onClose clears it.
  const [draftingRow, setDraftingRow] = useState<Row | null>(null);

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(
      `/api/enterprise-requests?workspace_id=${encodeURIComponent(workspaceId)}`,
      { cache: "no-store" }
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ApiResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "load failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, enabled]);

  const grouped = useMemo(() => {
    if (!data) return null;
    const buckets = new Map<EnterpriseRequestDerivedState, Row[]>();
    for (const state of STATE_ORDER) buckets.set(state, []);
    for (const row of data.rows) {
      const bucket = buckets.get(row.derived_state) ?? [];
      bucket.push(row);
      buckets.set(row.derived_state, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => {
        const at = a.submitted_at ?? "";
        const bt = b.submitted_at ?? "";
        return bt.localeCompare(at); // Newest first
      });
    }
    return buckets;
  }, [data]);

  if (!enabled || !workspaceId) return null;

  async function markNotified(row: Row, notified: boolean) {
    if (!workspaceId) return;
    const optimistic: Row = {
      ...row,
      notified: notified
        ? { ...row.notified, notified_at: new Date().toISOString() }
        : {},
    };
    setData((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.linear_issue_id === row.linear_issue_id ? optimistic : r
            ),
          }
        : prev
    );
    try {
      const r = await fetch("/api/enterprise-requests/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          linear_issue_id: row.linear_issue_id,
          action: notified ? "notified" : "cleared",
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      // Roll back optimistic update on failure.
      setData((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((rr) =>
                rr.linear_issue_id === row.linear_issue_id ? row : rr
              ),
            }
          : prev
      );
      console.warn("[requests] notify failed", e);
    }
  }

  return (
    <CollapsibleSection
      title="Requests"
      trailing={
        data ? (
          <span className="text-[11px] text-muted">
            {data.outstanding} outstanding · {data.delivered} delivered
          </span>
        ) : loading ? (
          <span className="text-[11px] text-muted italic">Loading…</span>
        ) : null
      }
      defaultOpen={false}
    >
      {loading ? (
        <p className="text-xs text-muted italic">Loading requests…</p>
      ) : error ? (
        <p className="text-xs text-muted italic">
          Couldn&rsquo;t load requests (fetch error). Try again in a
          moment.
        </p>
      ) : !data || data.rows.length === 0 ? (
        <p className="text-xs text-muted italic">
          No requests logged for this customer yet.
        </p>
      ) : (
        <div className="space-y-3">
          {STATE_ORDER.map((state) => {
            const rows = grouped?.get(state) ?? [];
            if (rows.length === 0) return null;
            return (
              <div key={state}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                  {state}
                  <span className="ml-1.5 text-muted">({rows.length})</span>
                </div>
                <ul className="space-y-1.5">
                  {rows.map((row) => (
                    <li
                      key={row.linear_issue_id}
                      className="rounded-md border border-border bg-surface p-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-blue-700 dark:text-blue-300 hover:underline break-words"
                          >
                            {row.linear_identifier}: {row.title}
                          </a>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted">
                            {row.work_type ? (
                              <span className="px-1 py-0.5 rounded border border-border-strong">
                                {row.work_type}
                              </span>
                            ) : null}
                            {row.customer_impact ? (
                              <span className="px-1 py-0.5 rounded border border-border-strong">
                                {row.customer_impact}
                              </span>
                            ) : null}
                            {row.estimate != null ? (
                              <span className="px-1 py-0.5 rounded border border-border-strong">
                                {estimateToTShirt(row.estimate) ??
                                  `est ${row.estimate}`}
                              </span>
                            ) : null}
                            {row.resurfaced ? (
                              <span className="px-1 py-0.5 rounded border border-amber-400 text-amber-700 dark:text-amber-300">
                                Resurfaced
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted">
                            Submitted {fmtDate(row.submitted_at)}
                            {row.submitting_csm_email
                              ? ` by ${row.submitting_csm_email}`
                              : ""}
                            {row.ship_date
                              ? ` · Shipped ${fmtDate(row.ship_date)}`
                              : ""}
                            {row.ship_url ? (
                              <>
                                {" · "}
                                <a
                                  href={row.ship_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 dark:text-blue-400 hover:underline"
                                >
                                  ↗ ship link
                                </a>
                              </>
                            ) : null}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATE_BADGE_CLASS[state]}`}
                        >
                          {state}
                        </span>
                      </div>
                      {(state === "Live" || state === "Live, possibly in beta") ? (
                        <div className="mt-1.5 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setDraftingRow(row);
                              // Stamp drafted_at eagerly — the API
                              // won't roll it back if the CSM
                              // abandons the modal.
                              void fetch(
                                "/api/enterprise-requests/notify",
                                {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    workspace_id: workspaceId,
                                    linear_issue_id: row.linear_issue_id,
                                    action: "drafted",
                                  }),
                                }
                              );
                            }}
                            className="px-2 py-0.5 text-[11px] rounded border border-border-strong hover:bg-canvas"
                          >
                            ✉ Draft outreach
                          </button>
                          <label className="inline-flex items-center gap-1 text-[11px] text-fg cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={!!row.notified.notified_at}
                              onChange={(e) =>
                                void markNotified(row, e.currentTarget.checked)
                              }
                              className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                            />
                            Notified{" "}
                            {row.notified.notified_at ? (
                              <span className="text-muted">
                                · {fmtDate(row.notified.notified_at)}
                              </span>
                            ) : null}
                          </label>
                          {row.notified.drafted_at && !row.notified.notified_at ? (
                            <span
                              className="text-[10px] text-amber-700 dark:text-amber-300"
                              title={`Draft opened ${fmtDate(row.notified.drafted_at)}`}
                            >
                              (draft opened)
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {draftingRow ? (
        <OutreachModal
          customer={customer}
          initialScenario="feature-shipped"
          feature={{
            title: draftingRow.title,
            // Linear issue bodies aren't persisted on the row today
            // (the sync only stores metadata to keep the snapshot
            // small). The template's {{feature.description}} tag
            // resolves to empty and its conditional-block wrapper
            // hides the surrounding paragraph — safe fallback.
            description: null,
            ship_url: draftingRow.ship_url ?? draftingRow.url,
            ship_date: draftingRow.ship_date
              ? fmtDate(draftingRow.ship_date)
              : draftingRow.promoted_at
                ? fmtDate(draftingRow.promoted_at)
                : null,
            beta_caveat:
              draftingRow.derived_state === "Live, possibly in beta"
                ? "This is currently in beta rollout — happy to share more if you'd like early access."
                : "",
          }}
          onDraftLifecycle={(state) => {
            // When the CSM actually creates the Gmail draft (not
            // just opens the modal), we upgrade the row's state
            // from `drafted` → `notified` on the "sent" event.
            // Today the modal fires "drafted" on Gmail-draft
            // creation — that's already the strongest signal the
            // CSM has committed to sending, so treat both as
            // notified. The row's notify UI will flip green on
            // next refetch.
            if (state === "drafted" || state === "sent") {
              void fetch("/api/enterprise-requests/notify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  workspace_id: workspaceId,
                  linear_issue_id: draftingRow.linear_issue_id,
                  action: "notified",
                }),
              }).then(() => {
                // Optimistically flip the row locally too, so the
                // Notified checkbox lights up without a manual
                // re-render.
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        rows: prev.rows.map((r) =>
                          r.linear_issue_id === draftingRow.linear_issue_id
                            ? {
                                ...r,
                                notified: {
                                  ...r.notified,
                                  notified_at: new Date().toISOString(),
                                },
                              }
                            : r
                        ),
                      }
                    : prev
                );
              });
            }
          }}
          onClose={() => setDraftingRow(null)}
        />
      ) : null}
    </CollapsibleSection>
  );
}
