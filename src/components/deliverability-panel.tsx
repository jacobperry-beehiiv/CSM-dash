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
  const data = initial;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useUrlSearch("q");
  const ownerEmailByWorkspace = useOwnerEmailMap(data.alerts);

  function toggle(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  /** Search filters by workspace name / subject — same shape as the
   *  other tabs so the filter strip stays consistent. */
  const alerts = useMemo(() => {
    if (!search) return data.alerts;
    const q = search.toLowerCase();
    return data.alerts.filter(
      (a) =>
        a.post.workspace_name.toLowerCase().includes(q) ||
        a.post.subject.toLowerCase().includes(q)
    );
  }, [data.alerts, search]);

  return (
    <div className="space-y-4">
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search workspace or subject…"
        />
        <CsmSelector csms={csms} />
      </FilterBar>
      <div className="text-xs text-muted">
        {(() => {
          const flaggedAll = data.alerts.filter((a) => a.flags.length > 0).length;
          const flaggedFiltered = alerts.filter((a) => a.flags.length > 0).length;
          if (search) {
            return (
              <>
                <strong className="text-fg">{alerts.length}</strong> of{" "}
                {data.alerts.length} sends match the filter (
                {flaggedFiltered} flagged)
              </>
            );
          }
          return (
            <>
              <strong className="text-fg">{data.alerts.length}</strong> sends
              · {flaggedAll} flagged
            </>
          );
        })()}
        {" · "}
        {data.target_date} · generated {fmtDate(data.generated_at)}
      </div>

      {alerts.length === 0 ? (
        <div className="bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-lg p-4 text-sm text-green-800 dark:text-green-200">
          {search ? (
            <>No sends match &ldquo;{search}&rdquo;.</>
          ) : data.total_posts_yesterday === 0 ? (
            <>No publications in this book sent on {data.target_date}.</>
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
              {alerts.map((alert, i) => {
                const k = `${alert.post.post_id}-${i}`;
                const isOpen = expanded.has(k);
                const flagged = alert.flags.length > 0;
                const critical = alert.flags.some((f) => f.severity === "critical");
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
                        {flagged ? (
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
                      </td>
                      <td className="px-3 py-3 break-words">
                        <div className="font-medium text-fg">
                          {alert.post.workspace_name}
                        </div>
                        <div className="text-xs text-muted truncate">
                          {alert.post.newsletter}
                        </div>
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
                              aria-label="Masquerade"
                              className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                            >
                              👤
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
