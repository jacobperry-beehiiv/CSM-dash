"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { fmtCompactCurrency, fmtDate, fmtNumber, fmtPct } from "./format";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RowActions } from "./row-actions";
import { RiskLevelChip } from "./risk-level-chip";
import { FlagResolutionCheckboxes } from "./flag-resolution-checkboxes";
import { composeUrlForTemplate } from "@/lib/links";
import { suggestTemplates } from "@/lib/templates/templates";
import type { StoredTemplate } from "@/lib/templates/store";
import { getTierLadder } from "@/lib/tiers/client";
import type { LastPostRow } from "@/lib/engines/last-post-batch";
import type { AtRiskAccount, Customer, RiskFlag } from "@/lib/types";
import type { TemplateScenario } from "@/lib/templates/templates";

interface RunResult {
  csm_name: string | null;
  total_in_book: number;
  excluded: number;
  accounts: AtRiskAccount[];
  generated_at: string;
}

const FLAG_COLORS: Record<string, string> = {
  A: "bg-blue-100 text-blue-800",
  B: "bg-indigo-100 text-indigo-800",
  C: "bg-amber-100 text-amber-800",
  D: "bg-red-100 text-red-800",
  E: "bg-orange-100 text-orange-800",
  F: "bg-purple-100 text-purple-800",
  G: "bg-rose-100 text-rose-800",
  H: "bg-orange-100 text-orange-800",
};

function suggestedTemplate(flags: RiskFlag[]): TemplateScenario {
  const codes = new Set(flags.map((f) => f.code));
  if (codes.has("G")) return "escalation-yellow-red";
  if (codes.has("A")) return "dormant-no-send";
  if (codes.has("C")) return "growth-push-under-tier";
  return "general-checkin";
}

function daysAgo(s: string | null | undefined): number | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function pctVal(c: Customer): number | null {
  if (c.percent_of_max_subs == null) return null;
  return c.percent_of_max_subs > 1
    ? c.percent_of_max_subs
    : c.percent_of_max_subs * 100;
}

export function AtRiskTable({ data }: { data: RunResult }) {
  const [outreachFor, setOutreachFor] = useState<{
    customer: Customer;
    scenario: TemplateScenario;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const allKeys = useMemo(
    () =>
      data.accounts
        .map((a, i) => a.customer.workspace_id ?? `${i}`)
        .filter((k): k is string => Boolean(k)),
    [data.accounts]
  );

  // Lazy-loaded "last published web post" per workspace. ClickHouse query
  // runs once for all visible accounts on mount, then caches in-process.
  const [lastPosts, setLastPosts] = useState<Record<string, LastPostRow>>({});
  useEffect(() => {
    const ids = data.accounts
      .map((a) => a.customer.workspace_id)
      .filter((x): x is string => Boolean(x));
    if (ids.length === 0) return;
    let cancelled = false;
    fetch("/api/last-post-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_ids: ids }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) setLastPosts(j);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [data.accounts]);

  // Reset selection + expansion when the underlying account set changes
  // (CSM filter, segment switch). Otherwise stale workspace IDs linger.
  const accountSignature = useMemo(
    () => allKeys.join("|"),
    [allKeys]
  );
  useEffect(() => {
    setSelected(new Set());
    setExpanded(new Set());
    setBulkMessage(null);
  }, [accountSignature]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelected(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    if (selected.size === allKeys.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allKeys));
    }
  }

  async function bulkResolve() {
    if (selected.size === 0) return;
    if (
      !confirm(
        `Mark every flag on ${selected.size} selected account${
          selected.size === 1 ? "" : "s"
        } as "I've reached out"? They'll drop off the next at-risk run.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setBulkMessage(null);
    let n = 0;
    for (const a of data.accounts) {
      const k = a.customer.workspace_id;
      if (!k || !selected.has(k)) continue;
      for (const f of a.flags) {
        try {
          await fetch("/api/flag-resolutions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspace_id: k,
              flag_code: f.code,
              resolved: true,
            }),
          });
          n++;
        } catch {
          /* keep going */
        }
      }
    }
    setBulkBusy(false);
    setBulkMessage(`Marked ${n} flag${n === 1 ? "" : "s"} resolved. Refresh to see updated list.`);
    setSelected(new Set());
  }

  async function bulkCompose() {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setBulkMessage(null);
    try {
      const [templatesRes, ladder] = await Promise.all([
        fetch("/api/templates").then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as StoredTemplate[];
        }),
        getTierLadder().catch(() => []),
      ]);
      const templates = templatesRes;
      let opened = 0;
      for (const a of data.accounts) {
        const k = a.customer.workspace_id;
        if (!k || !selected.has(k)) continue;
        const tplId = suggestedTemplate(a.flags);
        const tpl =
          templates.find((t) => t.id === tplId) ??
          templates.find((t) => t.id === "general-checkin") ??
          templates[0];
        if (!tpl) continue;
        const url = composeUrlForTemplate(tpl, a.customer, ladder);
        if (url) {
          window.open(url, "_blank", "noopener,noreferrer");
          opened++;
          // Stagger so popup blockers don't fire
          await new Promise((res) => setTimeout(res, 80));
        }
      }
      setBulkMessage(
        `Opened ${opened} Gmail compose tab${opened === 1 ? "" : "s"}.${
          opened !== selected.size
            ? " Some skipped (no email or template match)."
            : ""
        }`
      );
    } catch (e) {
      setBulkMessage(
        `Bulk compose failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">
        {data.accounts.length} flagged · {data.total_in_book} in book ·{" "}
        {data.excluded} excluded · generated {fmtDate(data.generated_at)}
      </div>

      {data.accounts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
          <span className="text-xs text-gray-600">
            <strong>{selected.size}</strong> selected of {allKeys.length}
          </span>
          <button
            onClick={selectAll}
            className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white hover:bg-gray-50"
          >
            {selected.size === allKeys.length ? "Deselect all" : "Select all"}
          </button>
          <div className="flex-1" />
          <button
            onClick={bulkCompose}
            disabled={bulkBusy || selected.size === 0}
            className="px-3 py-1 text-xs bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-50"
          >
            ✉️ Open Gmail for {selected.size}
          </button>
          <button
            onClick={bulkResolve}
            disabled={bulkBusy || selected.size === 0}
            className="px-3 py-1 text-xs border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            ✓ Mark all flags resolved for {selected.size}
          </button>
        </div>
      ) : null}

      {bulkMessage ? (
        <div className="text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded-md px-3 py-2">
          {bulkMessage}
        </div>
      ) : null}

      {data.accounts.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No at-risk accounts in this view. Nicely done.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-8" />
              <col className="w-8" />
              <col className="w-[18%]" />
              <col className="w-[7%]" />
              <col className="w-[9%]" />
              <col className="w-[9%]" />
              <col className="w-[10%]" />
              <col className="w-[7%]" />
              <col className="w-[8%]" />
              <col className="w-[14%] hidden lg:table-cell" />
              <col className="w-[14%]" />
            </colgroup>
            <thead className="bg-gray-50">
              <tr className="text-left border-b border-gray-200">
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3 font-medium text-gray-600">Account</th>
                <th className="px-3 py-3 font-medium text-gray-600 text-right">ARR</th>
                <th className="px-3 py-3 font-medium text-gray-600">Last send</th>
                <th className="px-3 py-3 font-medium text-gray-600">Last web post</th>
                <th className="px-3 py-3 font-medium text-gray-600">Last login</th>
                <th className="px-3 py-3 font-medium text-gray-600 text-right">% subs</th>
                <th className="px-3 py-3 font-medium text-gray-600">Risk</th>
                <th className="px-3 py-3 font-medium text-gray-600 hidden lg:table-cell">
                  Recommended action
                </th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a, i) => {
                const k = a.customer.workspace_id ?? `${i}`;
                const isOpen = expanded.has(k);
                const isChecked = selected.has(k);
                const c = a.customer;
                const flagCodes = new Set(a.flags.map((f) => f.code));

                const lastSendDays = daysAgo(c.last_send);
                const lastSendCls = flagCodes.has("A")
                  ? "text-red-600 font-semibold"
                  : "text-gray-700";

                const lastLoginDays = daysAgo(c.last_log_in);
                const lastLoginCls = flagCodes.has("B")
                  ? "text-red-600 font-semibold"
                  : "text-gray-700";

                const subs = pctVal(c);
                const subsCls = flagCodes.has("C")
                  ? "text-red-600 font-semibold"
                  : subs != null && subs > 90
                    ? "text-amber-600"
                    : "text-gray-700";

                return (
                  <Fragment key={k}>
                    <tr
                      onClick={() => toggleExpanded(k)}
                      className={`border-b border-gray-100 align-top cursor-pointer transition-colors ${
                        isOpen ? "bg-blue-50/40" : "hover:bg-blue-50/30"
                      }`}
                    >
                      <td
                        className="px-3 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelected(k)}
                          className="h-4 w-4 rounded border-gray-300 cursor-pointer"
                          aria-label={`Select ${c.company_name ?? "row"}`}
                        />
                      </td>
                      <td className="px-3 py-3 text-gray-400 select-none">
                        <span
                          className={`inline-block transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        >
                          ▸
                        </span>
                      </td>
                      <td className="px-3 py-3 break-words">
                        <div className="font-medium text-gray-900">
                          {c.company_name ?? c.workspace_name}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {c.customer_success_manager?.replace(/_/g, " ") ??
                            "unassigned"}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-medium">
                        {fmtCompactCurrency(c.arr)}
                      </td>
                      <td className={`px-3 py-3 ${lastSendCls}`}>
                        <div>{fmtDate(c.last_send)}</div>
                        {lastSendDays != null ? (
                          <div className="text-xs text-gray-500">
                            {lastSendDays}d ago
                          </div>
                        ) : (
                          <div className="text-xs text-gray-500">never</div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-gray-700">
                        {(() => {
                          const lp = c.workspace_id
                            ? lastPosts[c.workspace_id]
                            : undefined;
                          if (!lp) {
                            return (
                              <span className="text-xs text-gray-400 italic">
                                loading…
                              </span>
                            );
                          }
                          if (!lp.last_post_at) {
                            return (
                              <span className="text-xs text-gray-500 italic">
                                never
                              </span>
                            );
                          }
                          const ago = daysAgo(lp.last_post_at);
                          return (
                            <>
                              <div title={lp.last_post_title ?? undefined}>
                                {fmtDate(lp.last_post_at)}
                              </div>
                              {ago != null ? (
                                <div className="text-xs text-gray-500">
                                  {ago}d ago
                                </div>
                              ) : null}
                            </>
                          );
                        })()}
                      </td>
                      <td className={`px-3 py-3 ${lastLoginCls}`}>
                        {c.last_log_in ? (
                          <>
                            <div>{fmtDate(c.last_log_in)}</div>
                            {lastLoginDays != null ? (
                              <div className="text-xs text-gray-500">
                                {lastLoginDays}d ago
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="italic text-gray-500">14d+</span>
                        )}
                      </td>
                      <td className={`px-3 py-3 text-right ${subsCls}`}>
                        <div>{fmtPct(subs)}</div>
                        {c.active_subs != null ? (
                          <div className="text-xs text-gray-500">
                            {fmtNumber(c.active_subs)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <RiskLevelChip
                          level={c.property_risk_level}
                          detail={c.property_risk_level_detail}
                        />
                      </td>
                      <td className="px-3 py-3 text-gray-800 text-xs break-words hidden lg:table-cell">
                        {a.recommended_action}
                      </td>
                      <td className="px-3 py-3">
                        <RowActions
                          customer={c}
                          onDraft={() =>
                            setOutreachFor({
                              customer: c,
                              scenario: suggestedTemplate(a.flags),
                            })
                          }
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-blue-50/20 border-b border-gray-100">
                        <td colSpan={11} className="px-6 py-4">
                          <CustomerDetailPanel
                            customer={c}
                            hideFeatureBreakdown
                            topSlot={
                              <div className="space-y-3">
                                <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                                  <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-800 mb-2">
                                    Why this account is flagged
                                  </h4>
                                  <ul className="space-y-1">
                                    {a.flags.map((f) => (
                                      <li
                                        key={f.code}
                                        className="text-sm text-gray-800"
                                      >
                                        <span
                                          className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold mr-2 ${
                                            FLAG_COLORS[f.code] ?? "bg-gray-100"
                                          }`}
                                        >
                                          {f.code} · {f.label}
                                        </span>
                                        <span className="break-words">
                                          {f.detail}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                  <p className="mt-2 text-xs text-amber-900">
                                    <strong>Recommended action:</strong>{" "}
                                    {a.recommended_action}
                                  </p>
                                </div>
                                <FlagResolutionCheckboxes
                                  workspaceId={c.workspace_id}
                                  flags={a.flags}
                                />
                              </div>
                            }
                          />
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
        Click a row to expand details. Red values are the at-risk triggers.
      </p>

      {outreachFor && (
        <OutreachModal
          customer={outreachFor.customer}
          initialScenario={outreachFor.scenario}
          onClose={() => setOutreachFor(null)}
        />
      )}
    </div>
  );
}
