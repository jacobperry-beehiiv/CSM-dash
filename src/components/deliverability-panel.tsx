"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { SeverityBadge } from "./status-badge";
import { fmtDate, fmtNumber, fmtPct, fmtRate } from "./format";
import { masqueradeUrl, metabasePubUrl } from "@/lib/links";
import { FilterBar, SearchInput } from "./filters";
import { CsmSelector } from "./csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import type { Customer, DeliverabilityAlert } from "@/lib/types";

interface RunResult {
  target_date: string;
  csm_name: string | null;
  total_posts_yesterday: number;
  total_enterprise_posts: number;
  alerts: DeliverabilityAlert[];
  generated_at: string;
}

/**
 * Looks up `owner_email` for the workspaces in the alert list so per-row
 * masquerade links work. Fetches the customer book via /api/customers
 * once, indexed by workspace_id.
 */
function useOwnerEmailMap(alerts: DeliverabilityAlert[]): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/customers")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Customer[];
      })
      .then((list) => {
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const c of list) {
          if (c.workspace_id && c.owner_email) {
            m.set(c.workspace_id, c.owner_email);
          }
        }
        setMap(m);
      })
      .catch(() => {
        // Silent — masquerade links just won't render.
      });
    return () => {
      cancelled = true;
    };
    // alerts intentionally not in deps — fetch once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return map;
}

export function DeliverabilityPanel({
  initial,
  csms,
}: {
  initial: RunResult;
  csms: string[];
}) {
  // Local state mirrors the server's cleared resolutions so a Clear
  // click feels instant. The engine seeded each alert with its
  // cleared field on the server; we shadow that here so optimistic
  // updates don't lose state on re-render.
  const [data, setData] = useState<RunResult>(initial);
  // Posts the user has pending clear/un-clear requests on — used so
  // the button can show a brief "Clearing…" state without going
  // through a full reload.
  const [busyPosts, setBusyPosts] = useState<Set<string>>(new Set());
  const [showCleared, setShowCleared] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useUrlSearch("q");
  const ownerEmailByWorkspace = useOwnerEmailMap(data.alerts);

  async function setClearedOptimistic(
    postId: string,
    cleared: boolean,
    reason?: string
  ) {
    setBusyPosts((prev) => {
      const next = new Set(prev);
      next.add(postId);
      return next;
    });
    // Optimistic patch.
    const stamp = new Date().toISOString();
    setData((prev) => ({
      ...prev,
      alerts: prev.alerts.map((a) =>
        a.post.post_id !== postId
          ? a
          : {
              ...a,
              cleared: cleared
                ? {
                    cleared_at: stamp,
                    cleared_by: null,
                    reason: reason ?? null,
                  }
                : null,
            }
      ),
    }));
    try {
      const r = await fetch("/api/deliverability/clear", {
        method: cleared ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: postId, reason }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      // Roll back on failure.
      setData((prev) => ({
        ...prev,
        alerts: prev.alerts.map((a) =>
          a.post.post_id !== postId
            ? a
            : { ...a, cleared: cleared ? null : a.cleared }
        ),
      }));
      window.alert(
        `Clear failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setBusyPosts((prev) => {
        const next = new Set(prev);
        next.delete(postId);
        return next;
      });
    }
  }

  function toggle(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  /** Search filters by workspace name / subject — same shape as the
   *  other tabs so the filter strip stays consistent. Also matches the
   *  publication_id + organization_id carried on each post + the CSM
   *  attribution, so a paste-an-ID workflow works here too. */
  const alerts = useMemo(() => {
    if (!search) return data.alerts;
    const q = search.toLowerCase();
    // Beehiiv's customer-facing publication IDs carry a `pub_` prefix
    // (admin URLs, public API) but PostMetricsRow.publication_id is
    // the raw UUID. Strip the prefix off the query so either form
    // matches without the user needing to know which one we store.
    const qNoPubPrefix = q.startsWith("pub_") ? q.slice(4) : q;
    return data.alerts.filter((a) => {
      const csmRaw = a.csm ?? null;
      const csmHuman = csmRaw?.replace(/_/g, " ") ?? null;
      const pubId = a.post.publication_id.toLowerCase();
      return (
        a.post.workspace_name.toLowerCase().includes(q) ||
        a.post.subject.toLowerCase().includes(q) ||
        pubId.includes(q) ||
        pubId.includes(qNoPubPrefix) ||
        a.post.organization_id?.toLowerCase().includes(q) ||
        a.post.newsletter?.toLowerCase().includes(q) ||
        csmRaw?.toLowerCase().includes(q) ||
        csmHuman?.toLowerCase().includes(q)
      );
    });
  }, [data.alerts, search]);

  const clearedCount = useMemo(
    () => data.alerts.filter((a) => a.cleared).length,
    [data.alerts]
  );

  // Hide cleared sends from the default view; the toggle exposes them
  // with the "Cleared" pill + an undo button.
  const visibleAlerts = useMemo(
    () => alerts.filter((a) => showCleared || !a.cleared),
    [alerts, showCleared]
  );

  return (
    <div className="space-y-4">
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search workspace, subject, CSM, publication ID…"
        />
        <CsmSelector csms={csms} />
        {clearedCount > 0 ? (
          <label className="inline-flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={showCleared}
              onChange={(e) => setShowCleared(e.target.checked)}
              className="rounded border-border-strong"
            />
            <span>
              Show cleared ({clearedCount})
            </span>
          </label>
        ) : null}
      </FilterBar>
      <div className="text-xs text-muted">
        {(() => {
          const flaggedAll = data.alerts.filter(
            (a) => a.flags.length > 0 && !a.cleared
          ).length;
          const flaggedFiltered = visibleAlerts.filter(
            (a) => a.flags.length > 0 && !a.cleared
          ).length;
          const carryoverCount = data.alerts.filter(
            (a) => !a.cleared && a.post.sent_date !== data.target_date
          ).length;
          if (search) {
            return (
              <>
                <strong className="text-fg">{visibleAlerts.length}</strong> of{" "}
                {data.alerts.length} sends match the filter (
                {flaggedFiltered} active alerts)
              </>
            );
          }
          return (
            <>
              <strong className="text-fg">{visibleAlerts.length}</strong>{" "}
              {showCleared || clearedCount === 0 ? "sends" : "active sends"}
              {" · "}
              {flaggedAll} active alerts
              {carryoverCount > 0 ? (
                <>
                  {" · "}
                  <span
                    className="text-purple-700 dark:text-purple-300"
                    title="Uncleared critical sends from earlier dates that carry forward across data refreshes until a CSM clears them. Filter or browse the table to see them inline (purple Carryover pill)."
                  >
                    {carryoverCount} carried over
                  </span>
                </>
              ) : null}
              {clearedCount > 0 && !showCleared ? (
                <> · {clearedCount} cleared (hidden)</>
              ) : null}
            </>
          );
        })()}
        {" · "}
        {data.target_date} · generated {fmtDate(data.generated_at)}
      </div>

      {visibleAlerts.length === 0 ? (
        <div className="bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-lg p-4 text-sm text-green-800 dark:text-green-200">
          {search ? (
            <>No sends match &ldquo;{search}&rdquo;.</>
          ) : data.total_posts_yesterday === 0 ? (
            <>No publications in this book sent on {data.target_date}.</>
          ) : clearedCount > 0 && !showCleared ? (
            <>
              No active sends — all {clearedCount} of yesterday&apos;s sends
              have been cleared.
            </>
          ) : (
            <>
              No sends on {data.target_date} for the selected scope.
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface shadow-card overflow-x-auto">
          <table className="w-full text-sm">
            <colgroup>
              <col className="w-8" />
              <col className="w-[8%]" />
              <col className="w-[18%]" />
              <col className="w-[22%] hidden md:table-cell" />
              <col className="w-[7%]" />
              <col className="w-[7%]" />
              <col className="w-[7%]" />
              <col className="w-[7%] hidden xl:table-cell" />
              <col className="w-[7%] hidden xl:table-cell" />
              <col className="w-[10%] hidden lg:table-cell" />
              <col className="w-[7%]" />
            </colgroup>
            <thead className="bg-canvas">
              <tr className="text-left border-b border-border">
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3 font-medium text-muted">Status</th>
                <th className="px-3 py-3 font-medium text-muted">Workspace</th>
                <th className="px-3 py-3 font-medium text-muted hidden md:table-cell">
                  Subject
                </th>
                <th className="px-3 py-3 font-medium text-muted text-right">
                  Sent
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right"
                  title="Delivery rate (delivered / sent)"
                >
                  Deliv
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right"
                  title="Open rate (opens / delivered)"
                >
                  Open
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right hidden xl:table-cell"
                  title="Click-through rate (clicks / delivered)"
                >
                  CTR
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right hidden xl:table-cell"
                  title="Spam complaint rate"
                >
                  Spam
                </th>
                <th className="px-3 py-3 font-medium text-muted hidden lg:table-cell">
                  CSM
                </th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visibleAlerts.map((alert, i) => {
                const k = `${alert.post.post_id}-${i}`;
                const isOpen = expanded.has(k);
                const flagged = alert.flags.length > 0;
                const cleared = Boolean(alert.cleared);
                const busy = busyPosts.has(alert.post.post_id);
                const critical =
                  !cleared && alert.flags.some((f) => f.severity === "critical");
                // Carryover row: a critical send from an earlier date
                // that the CSM hasn't cleared yet. The engine carries
                // these forward across data refreshes so a critical
                // issue doesn't drop out of view just because today's
                // data set landed. The badge + sent-date hint signal
                // "you're seeing this because nobody cleared it yet."
                const isCarryover = alert.post.sent_date !== data.target_date;
                const email = ownerEmailByWorkspace.get(alert.post.organization_id);
                const masqUrl = email ? masqueradeUrl(email) : null;
                const mbUrl = metabasePubUrl({
                  workspace_id: alert.post.organization_id,
                  workspace_name: alert.post.workspace_name,
                  publication_id: alert.post.publication_id,
                });
                return (
                  <Fragment key={k}>
                    <tr
                      onClick={() => toggle(k)}
                      className={`border-b border-border align-top cursor-pointer transition-colors ${
                        isOpen
                          ? flagged
                            ? critical
                              ? "bg-red-50 dark:bg-red-500/60"
                              : "bg-amber-50 dark:bg-amber-500/60"
                            : "bg-blue-50 dark:bg-blue-500/30"
                          : "hover:bg-blue-50 dark:hover:bg-blue-500/15"
                      }`}
                    >
                      <td className="px-3 py-3 text-subtle select-none">
                        <span
                          className={`inline-block transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        >
                          ▸
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col items-start gap-1">
                          {cleared ? (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-slate-200 text-slate-700 dark:bg-slate-500/30 dark:text-slate-200"
                              title={`Cleared ${
                                alert.cleared?.cleared_by ?? ""
                              } ${alert.cleared?.cleared_at ?? ""}`.trim()}
                            >
                              Cleared
                            </span>
                          ) : flagged ? (
                            <SeverityBadge
                              severity={critical ? "critical" : "warning"}
                            />
                          ) : (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200"
                              title="No deliverability thresholds tripped"
                            >
                              Clean
                            </span>
                          )}
                          {isCarryover && !cleared ? (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200"
                              title="Critical send from an earlier date — carried forward until you clear it so issues don't disappear on data refresh."
                            >
                              Carryover
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 break-words">
                        <div className="font-medium text-fg">
                          {alert.post.workspace_name}
                        </div>
                        <div className="text-xs text-muted truncate">
                          {alert.post.newsletter}
                        </div>
                        {isCarryover ? (
                          <div
                            className="text-[10px] text-subtle mt-0.5"
                            title={`This row's send date is ${alert.post.sent_date} — older than the panel's target date (${data.target_date}). It carried forward because it tripped a critical flag and wasn't cleared.`}
                          >
                            Sent {fmtDate(alert.post.sent_date)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-muted italic break-words hidden md:table-cell">
                        &ldquo;{alert.post.subject}&rdquo;
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {fmtNumber(alert.post.sent)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {fmtPct(alert.post.delivery_rate * 100, 1)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {fmtPct(alert.post.open_rate * 100, 1)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums hidden xl:table-cell">
                        {fmtPct(alert.post.ctr * 100, 1)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums hidden xl:table-cell">
                        {fmtRate(alert.post.spam_rate * 100, 3)}%
                      </td>
                      <td className="px-3 py-3 text-muted hidden lg:table-cell break-words">
                        {alert.csm?.replace(/_/g, " ") ?? (
                          <span className="text-subtle italic">unassigned</span>
                        )}
                      </td>
                      <td
                        className="px-3 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1 justify-end">
                          {masqUrl ? (
                            <a
                              href={masqUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Masquerade into workspace"
                              className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                            >
                              Masq
                            </a>
                          ) : null}
                          {mbUrl ? (
                            <a
                              href={mbUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open Metabase dashboard for this publication"
                              aria-label="Open Metabase"
                              className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                            >
                              📊
                            </a>
                          ) : null}
                          {flagged ? (
                            cleared ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void setClearedOptimistic(
                                    alert.post.post_id,
                                    false
                                  )
                                }
                                title="Restore this send to the active alerts list."
                                aria-label="Undo clear"
                                className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas disabled:opacity-50"
                              >
                                {busy ? "…" : "Undo"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  const reason =
                                    window.prompt(
                                      "Optional reason for clearing this send (visible to the team). Leave blank to skip."
                                    ) ?? "";
                                  void setClearedOptimistic(
                                    alert.post.post_id,
                                    true,
                                    reason || undefined
                                  );
                                }}
                                title="Acknowledge this flagged send and hide it from the active alerts list. Undo from the Show-cleared view."
                                aria-label="Clear flagged send"
                                className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas disabled:opacity-50"
                              >
                                {busy ? "…" : "Clear"}
                              </button>
                            )
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr
                        className={`border-b border-border ${
                          flagged
                            ? critical
                              ? "bg-red-50 dark:bg-red-500/30"
                              : "bg-amber-50 dark:bg-amber-500/30"
                            : "bg-blue-50 dark:bg-blue-500/15"
                        }`}
                      >
                        <td colSpan={11} className="px-6 py-4">
                          <DeliverabilityDetail alert={alert} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-subtle">
        Every send in scope is listed — flagged rows are sorted to the top.
        Click any row for a full metric breakdown and flag details.
      </p>
    </div>
  );
}

function DeliverabilityDetail({ alert }: { alert: DeliverabilityAlert }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">
        Sent {fmtDate(alert.post.sent_date)} · {fmtNumber(alert.post.sent)}{" "}
        recipients · {alert.post.newsletter}
      </div>

      {alert.cleared ? (
        <div className="rounded-md border border-slate-300 dark:border-slate-500/30 bg-slate-100 dark:bg-slate-500/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-200">
          Cleared {fmtDate(alert.cleared.cleared_at)}
          {alert.cleared.cleared_by ? <> by {alert.cleared.cleared_by}</> : null}
          {alert.cleared.reason ? (
            <>
              {" · "}
              <span className="italic">&ldquo;{alert.cleared.reason}&rdquo;</span>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 bg-surface rounded-md border border-border p-3">
        <Metric label="Delivered" value={fmtRate(alert.post.delivery_rate)} />
        <Metric label="Open" value={fmtRate(alert.post.open_rate)} />
        <Metric label="Click" value={fmtRate(alert.post.ctr)} />
        <Metric label="Hard bnc" value={fmtRate(alert.post.hard_bounce_rate)} />
        <Metric label="Unsub" value={fmtRate(alert.post.unsub_rate)} />
        <Metric label="Spam" value={fmtRate(alert.post.spam_rate, 3)} />
      </div>

      <div className="bg-surface rounded-md border border-border p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
          Flags ({alert.flags.length})
        </h4>
        {alert.flags.length === 0 ? (
          <p className="text-sm text-muted">
            No thresholds tripped — every deliverability metric is in healthy
            range.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {alert.flags.map((f) => (
              <li key={f.code} className="text-sm flex items-start gap-2">
                <span
                  className={
                    f.severity === "critical"
                      ? "text-red-600 font-medium flex-shrink-0"
                      : "text-amber-700 flex-shrink-0"
                  }
                >
                  ▸
                </span>
                <span className="text-fg break-words">{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-medium text-fg">{value}</div>
    </div>
  );
}
