"use client";

import { useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtDate } from "../format";
import { OutreachModal } from "../outreach-modal";
import type {
  EnterpriseRequestRow,
  NotifiedEntry,
} from "@/lib/data/enterprise-requests-types";

/**
 * "Live This Week" tab body — the CSM's outreach action queue for
 * feature requests that shipped in the last 7 days. Fed by the
 * enterprise-requests snapshot + notified overlay via
 * `/api/enterprise-requests/live-this-week?csm=<email-or-handle>`;
 * per-row Draft outreach opens the shared OutreachModal with the
 * `feature-shipped` scenario, matching the profile Requests
 * section's behavior so both surfaces stay in sync.
 *
 * The row's Customer object is resolved from the caller-passed
 * `customersByWorkspace` map — same book the /csm page already
 * loads for the customer table, so we don't double-fetch.
 */

interface Row extends EnterpriseRequestRow {
  workspace_id: string;
  workspace_name: string | null;
  notified: NotifiedEntry;
}

interface ApiResponse {
  csm: string;
  rows: Row[];
  count: number;
  last_synced_at: string;
}

interface Props {
  /** CSM handle (or email) to scope the queue to. Passed straight
   *  through to the API — an empty string means "the viewer". */
  csmParam: string | null;
  /** Book indexed by workspace_id so the Draft-outreach modal can
   *  open with the full Customer record (needed for recipient
   *  picker + merge tags) without an extra fetch. */
  customersByWorkspace: Record<string, Customer>;
}

export function LiveThisWeek({ csmParam, customersByWorkspace }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNotified, setShowNotified] = useState(false);
  const [draftingRow, setDraftingRow] = useState<Row | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (csmParam) qs.set("csm", csmParam);
    if (showNotified) qs.set("include_notified", "1");
    fetch(`/api/enterprise-requests/live-this-week?${qs}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ApiResponse;
      })
      .then((body) => !cancelled && setData(body))
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "load failed");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [csmParam, showNotified]);

  async function markNotified(row: Row, notified: boolean) {
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
              r.workspace_id === row.workspace_id &&
              r.linear_issue_id === row.linear_issue_id
                ? optimistic
                : r
            ),
          }
        : prev
    );
    try {
      const r = await fetch("/api/enterprise-requests/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: row.workspace_id,
          linear_issue_id: row.linear_issue_id,
          action: notified ? "notified" : "cleared",
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      setData((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((rr) =>
                rr.workspace_id === row.workspace_id &&
                rr.linear_issue_id === row.linear_issue_id
                  ? row
                  : rr
              ),
            }
          : prev
      );
      console.warn("[live-this-week] notify failed", e);
    }
  }

  const rowsByCustomer = useMemo(() => {
    if (!data) return null;
    // Group by workspace so a customer with multiple shipped items
    // renders as one card, mirroring the profile Requests section's
    // "one customer, N requests" shape.
    const buckets = new Map<string, Row[]>();
    for (const r of data.rows) {
      const bucket = buckets.get(r.workspace_id) ?? [];
      bucket.push(r);
      buckets.set(r.workspace_id, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) =>
        (b.promoted_at ?? "").localeCompare(a.promoted_at ?? "")
      );
    }
    return buckets;
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">
            Feature requests from your accounts that shipped in the last
            7 days. Draft a note to the customer to close the loop, then
            check the box so the row drops off the digest.
          </p>
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-fg cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showNotified}
            onChange={(e) => setShowNotified(e.currentTarget.checked)}
            className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
          />
          Show already-notified
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-muted italic">Loading shipped requests…</p>
      ) : error ? (
        <div className="text-sm bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-red-800 dark:text-red-300">
          Failed to load: {error}
        </div>
      ) : !data || data.rows.length === 0 ? (
        <p className="text-sm text-muted italic">
          No requests from your accounts shipped this week.
        </p>
      ) : (
        <div className="space-y-3">
          {(rowsByCustomer
            ? Array.from(rowsByCustomer.entries())
            : ([] as Array<[string, Row[]]>)
          ).map(([workspaceId, rows]) => {
            const customer = customersByWorkspace[workspaceId];
            const name =
              customer?.company_name ??
              customer?.workspace_name ??
              rows[0].workspace_name ??
              workspaceId;
            return (
              <div
                key={workspaceId}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-semibold text-fg">{name}</div>
                  <div className="text-[11px] text-muted">
                    {rows.length} shipped this week
                  </div>
                </div>
                <ul className="space-y-2">
                  {rows.map((row) => (
                    <li
                      key={row.linear_issue_id}
                      className="rounded border border-border p-2 text-xs"
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
                          <div className="mt-0.5 text-[10px] text-muted">
                            Shipped {fmtDate(row.ship_date ?? row.promoted_at)}
                            {row.derived_state === "Live, possibly in beta" ? (
                              <span className="ml-1.5 rounded border border-amber-400 bg-amber-50 dark:bg-amber-500/10 px-1 py-0.5 text-amber-800 dark:text-amber-200 text-[9px] font-semibold">
                                POSSIBLY IN BETA
                              </span>
                            ) : null}
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
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        {customer ? (
                          <button
                            type="button"
                            onClick={() => {
                              setDraftingRow(row);
                              void fetch(
                                "/api/enterprise-requests/notify",
                                {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    workspace_id: row.workspace_id,
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
                        ) : (
                          <span
                            className="text-[10px] text-muted italic"
                            title="Customer not in the current book scope — reload with ?csm=all to draft."
                          >
                            (customer not in scope)
                          </span>
                        )}
                        <label className="inline-flex items-center gap-1 text-[11px] text-fg cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={!!row.notified.notified_at}
                            onChange={(e) =>
                              void markNotified(row, e.currentTarget.checked)
                            }
                            className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                          />
                          Notified
                          {row.notified.notified_at ? (
                            <span className="text-muted">
                              · {fmtDate(row.notified.notified_at)}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {draftingRow && customersByWorkspace[draftingRow.workspace_id] ? (
        <OutreachModal
          customer={customersByWorkspace[draftingRow.workspace_id]}
          initialScenario="feature-shipped"
          feature={{
            title: draftingRow.title,
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
            if (state === "drafted" || state === "sent") {
              const stashRow = draftingRow;
              void fetch("/api/enterprise-requests/notify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  workspace_id: stashRow.workspace_id,
                  linear_issue_id: stashRow.linear_issue_id,
                  action: "notified",
                }),
              }).then(() => {
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        rows: prev.rows.map((r) =>
                          r.workspace_id === stashRow.workspace_id &&
                          r.linear_issue_id === stashRow.linear_issue_id
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
    </div>
  );
}
