"use client";

import { Fragment, useEffect, useState } from "react";
import { SeverityBadge } from "./status-badge";
import { fmtDate, fmtNumber, fmtRate } from "./format";
import { masqueradeUrl, metabasePubUrl } from "@/lib/links";
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

export function DeliverabilityPanel({ initial }: { initial: RunResult }) {
  const data = initial;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const ownerEmailByWorkspace = useOwnerEmailMap(data.alerts);

  function toggle(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">
        {data.alerts.length} flagged · {data.total_posts_yesterday} posts on{" "}
        {data.target_date} · generated {fmtDate(data.generated_at)}
      </div>

      {data.alerts.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No red flags for {data.target_date}. Analyzed{" "}
          {data.total_posts_yesterday} posts.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-8" />
              <col className="w-[9%]" />
              <col className="w-[22%]" />
              <col className="w-[28%] hidden md:table-cell" />
              <col className="w-[8%]" />
              <col className="w-[12%] hidden lg:table-cell" />
              <col className="w-[12%]" />
            </colgroup>
            <thead className="bg-gray-50">
              <tr className="text-left border-b border-gray-200">
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3 font-medium text-gray-600">Severity</th>
                <th className="px-3 py-3 font-medium text-gray-600">Workspace</th>
                <th className="px-3 py-3 font-medium text-gray-600 hidden md:table-cell">
                  Subject
                </th>
                <th className="px-3 py-3 font-medium text-gray-600 text-right">
                  Sent
                </th>
                <th className="px-3 py-3 font-medium text-gray-600 hidden lg:table-cell">
                  CSM
                </th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map((alert, i) => {
                const k = `${alert.post.post_id}-${i}`;
                const isOpen = expanded.has(k);
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
                      className={`border-b border-gray-100 align-top cursor-pointer transition-colors ${
                        isOpen
                          ? critical
                            ? "bg-red-50/60"
                            : "bg-amber-50/60"
                          : "hover:bg-blue-50/30"
                      }`}
                    >
                      <td className="px-3 py-3 text-gray-400 select-none">
                        <span
                          className={`inline-block transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        >
                          ▸
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <SeverityBadge
                          severity={critical ? "critical" : "warning"}
                        />
                      </td>
                      <td className="px-3 py-3 break-words">
                        <div className="font-medium text-gray-900">
                          {alert.post.workspace_name}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {alert.post.newsletter}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-gray-700 italic break-words hidden md:table-cell">
                        &ldquo;{alert.post.subject}&rdquo;
                      </td>
                      <td className="px-3 py-3 text-right">
                        {fmtNumber(alert.post.sent)}
                      </td>
                      <td className="px-3 py-3 text-gray-600 hidden lg:table-cell break-words">
                        {alert.csm?.replace(/_/g, " ") ?? (
                          <span className="text-gray-400 italic">unassigned</span>
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
                              className="px-2 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50"
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
                              className="px-2 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50"
                            >
                              📊
                            </a>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr
                        className={`border-b border-gray-100 ${
                          critical ? "bg-red-50/30" : "bg-amber-50/30"
                        }`}
                      >
                        <td colSpan={7} className="px-6 py-4">
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

      <p className="text-xs text-gray-400">
        Click a row to see flag details and full metric breakdown.
      </p>
    </div>
  );
}

function DeliverabilityDetail({ alert }: { alert: DeliverabilityAlert }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-600">
        Sent {fmtDate(alert.post.sent_date)} · {fmtNumber(alert.post.sent)}{" "}
        recipients · {alert.post.newsletter}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 bg-white rounded-md border border-gray-200 p-3">
        <Metric label="Delivered" value={fmtRate(alert.post.delivery_rate)} />
        <Metric label="Open" value={fmtRate(alert.post.open_rate)} />
        <Metric label="Click" value={fmtRate(alert.post.ctr)} />
        <Metric label="Hard bnc" value={fmtRate(alert.post.hard_bounce_rate)} />
        <Metric label="Unsub" value={fmtRate(alert.post.unsub_rate)} />
        <Metric label="Spam" value={fmtRate(alert.post.spam_rate, 3)} />
      </div>

      <div className="bg-white rounded-md border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
          Flags ({alert.flags.length})
        </h4>
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
              <span className="text-gray-800 break-words">{f.message}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="font-medium text-gray-900">{value}</div>
    </div>
  );
}
