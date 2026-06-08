"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { fmtCurrency, fmtDate, fmtNumber, fmtPct, daysAgo } from "./format";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { useGmailLastContact } from "@/lib/hooks/use-gmail-last-contact";
import { lastContacted } from "@/lib/customer-helpers";
import { RowActions } from "./row-actions";
import { BulkEmailLauncher } from "./am/bulk-email-launcher";
import { RiskLevelChip } from "./risk-level-chip";
import { FlagResolutionCheckboxes } from "./flag-resolution-checkboxes";
import { ChipMultiSelect, FilterBar, FilterPanel, SearchInput, SegmentToggle } from "./filters";
import { CsmSelector } from "./csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import { composeUrlForTemplate } from "@/lib/links";
import { suggestTemplates } from "@/lib/templates/templates";
import { isVisibleToCsm, type StoredTemplate } from "@/lib/templates/types";
import { useViewerEmail } from "@/lib/auth-client";
import { getTierLadder } from "@/lib/tiers/client";
import type {
  AtRiskAccount,
  Customer,
  RiskFlag,
  RiskFlagCode,
} from "@/lib/types";
import type { TemplateScenario } from "@/lib/templates/templates";

// Short, human-readable label per flag code — drives the filter chips
// and the per-row flag chips. Labels are deliberately specific about
// the trigger ("No publishing 10d+") rather than vague ("Dormant") so
// you can tell at a glance which signal fired without hovering for
// the tooltip. Engine labels in lib/engines/at-risk.ts use the same
// strings (the row chip rendering reads `f.label` from the engine
// directly) so the two surfaces stay consistent.
//
// Order matters: the strip renders flags in this declared order so
// the most-common codes (A/B/C/G/H) come first.
const FLAG_META: Array<{ code: RiskFlagCode; label: string; description: string }> = [
  {
    code: "A",
    label: "No publishing (10d+)",
    description: "Hasn't sent a post in 10+ days, or never sent",
  },
  {
    code: "B",
    label: "No login (14d+)",
    description: "No admin login to beehiiv in the last 14 days",
  },
  {
    code: "C",
    label: "Under cap (<75%)",
    description: "Active subscribers below 75% of plan limit",
  },
  {
    code: "G",
    label: "CSM-flagged risk",
    description: "Yellow / Red risk level set on the HubSpot company record",
  },
  {
    code: "H",
    label: "Stale HubSpot activity (45d+)",
    description:
      "No HubSpot-tracked email / call / note activity across any contact at this company in 45+ days",
  },
  {
    code: "D",
    label: "Frustration signal",
    description: "Negative-sentiment Gmail signal detected in last 30 days",
  },
  {
    code: "E",
    label: "No outbound (90d+)",
    description: "No outbound email to this company in 90+ days (Gmail-detected)",
  },
  {
    code: "F",
    label: "News mention",
    description: "Notable news (acquisition, layoffs, etc.) on contact or company",
  },
];

interface RunResult {
  csm_name: string | null;
  total_in_book: number;
  excluded: number;
  accounts: AtRiskAccount[];
  generated_at: string;
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

function suggestedTemplate(flags: RiskFlag[]): TemplateScenario {
  const codes = new Set(flags.map((f) => f.code));
  if (codes.has("G")) return "escalation-yellow-red";
  if (codes.has("A")) return "dormant-no-send";
  if (codes.has("C")) return "growth-push-under-tier";
  return "general-checkin";
}

function pctVal(c: Customer): number | null {
  if (c.percent_of_max_subs == null) return null;
  return c.percent_of_max_subs > 1
    ? c.percent_of_max_subs
    : c.percent_of_max_subs * 100;
}

export function AtRiskTable({
  data,
  csms,
}: {
  data: RunResult;
  csms: string[];
}) {
  const viewerEmail = useViewerEmail();
  const [outreachFor, setOutreachFor] = useState<{
    customer: Customer;
    scenario: TemplateScenario;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  // Client-side search across the already-flagged accounts. URL-synced
  // (`?q=…`) so navigating away and back restores the filter.
  const [search, setSearch] = useUrlSearch("q");
  // Publications index for the "paste a pub_… UUID" affordance.
  const { ws2pubs } = usePublicationsIndex();

  // Gmail-direct "Last contacted" overlay. Same hook as the customer
  // table — batches one POST on mount, results are merged into the
  // detail panel's "Last contacted" row when expanded. The at-risk
  // page benefits especially because Flag H ("Stale HubSpot
  // activity") often fires on accounts a CSM actually emailed last
  // week; the Gmail overlay surfaces the correction visually.
  const ownerEmailList = useMemo(
    () =>
      data.accounts
        .map((a) => a.customer.owner_email ?? "")
        .filter((e): e is string => Boolean(e)),
    [data.accounts]
  );
  const gmail = useGmailLastContact(ownerEmailList);
  const gmailDateFor = useCallback(
    (c: Customer): string | undefined => {
      const email = (c.owner_email ?? "").trim().toLowerCase();
      if (!email) return undefined;
      return gmail.dateMap[email] ?? undefined;
    },
    [gmail.dateMap]
  );

  // Flag filter state. Empty pickedFlags = no filter (show all accounts).
  // combine = "any" matches accounts with at least one picked flag;
  // "all" requires every picked flag to be present.
  const [pickedFlags, setPickedFlags] = useState<Set<RiskFlagCode>>(new Set());
  const [combine, setCombine] = useState<"any" | "all">("any");

  function toggleFlag(code: RiskFlagCode) {
    setPickedFlags((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  // Per-flag count across the whole result so the chip can show "(N)".
  // Independent of the active filter — always reflects the underlying data.
  const flagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of data.accounts) {
      for (const f of a.flags) {
        counts[f.code] = (counts[f.code] ?? 0) + 1;
      }
    }
    return counts;
  }, [data.accounts]);

  const accounts = useMemo(() => {
    let list = data.accounts;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(({ customer: c }) => {
        // CSMs are stored snake_cased — humanize so "olivia chen" and
        // "olivia_chen" both match. Same pattern used in customer-table.
        const csmRaw = c.customer_success_manager ?? null;
        const csmHuman = csmRaw?.replace(/_/g, " ") ?? null;
        // Pub IDs owned by this workspace so a pasted `pub_…` UUID
        // surfaces the parent account.
        const pubs = c.workspace_id ? ws2pubs[c.workspace_id] ?? [] : [];
        if (
          c.company_name?.toLowerCase().includes(q) ||
          c.workspace_name?.toLowerCase().includes(q) ||
          c.owner_email?.toLowerCase().includes(q) ||
          c.workspace_id?.toLowerCase().includes(q) ||
          c.stripe_customer_id?.toLowerCase().includes(q) ||
          csmRaw?.toLowerCase().includes(q) ||
          csmHuman?.toLowerCase().includes(q)
        ) {
          return true;
        }
        return pubs.some((p) => p.toLowerCase().includes(q));
      });
    }
    if (pickedFlags.size === 0) return list;
    return list.filter((a) => {
      const codes = new Set(a.flags.map((f) => f.code));
      if (combine === "any") {
        for (const code of pickedFlags) if (codes.has(code)) return true;
        return false;
      }
      for (const code of pickedFlags) if (!codes.has(code)) return false;
      return true;
    });
  }, [data.accounts, pickedFlags, combine, search, ws2pubs]);

  const allKeys = useMemo(
    () =>
      accounts
        .map((a, i) => a.customer.workspace_id ?? `${i}`)
        .filter((k): k is string => Boolean(k)),
    [accounts]
  );

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
    for (const a of accounts) {
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
      const templates = templatesRes.filter((t) =>
        isVisibleToCsm(t, viewerEmail)
      );
      let opened = 0;
      for (const a of accounts) {
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

  const filterActive = pickedFlags.size > 0;
  const modeLabel = combine === "any" ? "any of" : "all of";

  return (
    <div className="space-y-4">
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name, owner, CSM, workspace / publication ID…"
        />
        <CsmSelector csms={csms} />
      </FilterBar>
      <div className="text-xs text-muted">
        {filterActive || search ? (
          <>
            <strong className="text-fg">{accounts.length}</strong> of{" "}
            {data.accounts.length} flagged accounts match the filter
          </>
        ) : (
          <>{data.accounts.length} flagged</>
        )}
        {" · "}
        {data.total_in_book} in book · {data.excluded} excluded · generated{" "}
        {fmtDate(data.generated_at)}
      </div>

      {data.accounts.length > 0 ? (
        <FilterPanel
          title="Filter by flag"
          defaultOpen={filterActive}
          trailing={
            filterActive ? (
              <span>
                {pickedFlags.size} selected · {modeLabel}
              </span>
            ) : null
          }
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted font-medium">Combine:</span>
              <SegmentToggle
                variant="compact"
                ariaLabel="Combine mode"
                options={[
                  { value: "any", label: "any" },
                  { value: "all", label: "all" },
                ]}
                value={combine}
                onChange={(v) => setCombine(v)}
              />
              {filterActive ? (
                <button
                  onClick={() => setPickedFlags(new Set())}
                  className="text-accent hover:underline ml-auto"
                >
                  Clear ({pickedFlags.size} selected · {modeLabel})
                </button>
              ) : (
                <span className="text-subtle ml-auto">
                  no flags selected — showing every flagged account
                </span>
              )}
            </div>
            <ChipMultiSelect
              options={FLAG_META.map(({ code, label, description }) => ({
                value: code,
                label,
                description: `${code} — ${description}`,
                badge: code,
                badgeClass: FLAG_COLORS[code] ?? "bg-surface-2",
              }))}
              selected={pickedFlags}
              onToggle={toggleFlag}
              countMap={flagCounts}
            />
          </div>
        </FilterPanel>
      ) : null}

      {data.accounts.length > 0 && accounts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-canvas border border-border rounded-md">
          <span className="text-xs text-muted">
            <strong>{selected.size}</strong> selected of {allKeys.length}
          </span>
          <button
            onClick={selectAll}
            className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
          >
            {selected.size === allKeys.length ? "Deselect all" : "Select all"}
          </button>
          <div className="flex-1" />
          {/* Resolve the selected at-risk accounts to Customer[] for
           *  the BulkEmailLauncher. Same Customer object the table
           *  rows already hold — no extra fetch needed. Filter on
           *  workspace_id because that's the selection key. */}
          {(() => {
            const selectedCustomers = accounts
              .filter((a) =>
                a.customer.workspace_id
                  ? selected.has(a.customer.workspace_id)
                  : false
              )
              .map((a) => a.customer);
            return (
              <BulkEmailLauncher
                customers={selectedCustomers}
                defaultTemplateId="general-checkin"
                disabled={selected.size === 0}
                label={`📥 Draft for ${selected.size}`}
                trackingIdFor={(c) => c.workspace_id ?? null}
              />
            );
          })()}
          <button
            onClick={bulkCompose}
            disabled={bulkBusy || selected.size === 0}
            className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
            title="Open one Gmail compose tab per selected account using the per-flag suggested template. Faster than the modal when you just want to fan out browser tabs."
          >
            ✉️ Open Gmail for {selected.size}
          </button>
          <button
            onClick={bulkResolve}
            disabled={bulkBusy || selected.size === 0}
            className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
          >
            ✓ Mark all flags resolved for {selected.size}
          </button>
        </div>
      ) : null}

      {bulkMessage ? (
        <div className="text-xs text-muted bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-accent/30 rounded-md px-3 py-2">
          {bulkMessage}
        </div>
      ) : null}

      {data.accounts.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No at-risk accounts in this view. Nicely done.
        </div>
      ) : accounts.length === 0 ? (
        <div className="bg-canvas border border-border rounded-lg p-4 text-sm text-muted">
          No flagged accounts match the current filter. Clear or loosen the
          filter to see results.
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface shadow-card">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-8" />
              <col className="w-8" />
              <col className="w-[14%]" />
              <col className="w-[6%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              {/* Last contacted — Gmail / HubSpot merged date with
               *  source pill. Hidden below lg since it's secondary to
               *  the structured flag/risk cells and we don't want to
               *  squeeze them on narrower viewports. */}
              <col className="w-[9%] hidden lg:table-cell" />
              <col className="w-[6%]" />
              <col className="w-[6%]" />
              <col className="w-[12%] hidden lg:table-cell" />
              {/* Actions — wide enough for Masquerade + h. + Draft. */}
              <col className="w-[15%]" />
            </colgroup>
            <thead className="bg-canvas">
              <tr className="text-left border-b border-border">
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3 font-medium text-muted">Account</th>
                <th className="px-3 py-3 font-medium text-muted text-right">ARR</th>
                <th className="px-3 py-3 font-medium text-muted">Last send</th>
                <th className="px-3 py-3 font-medium text-muted">Flags</th>
                <th className="px-3 py-3 font-medium text-muted">Last login</th>
                <th className="px-3 py-3 font-medium text-muted hidden lg:table-cell whitespace-nowrap">
                  Last contacted
                </th>
                <th className="px-3 py-3 font-medium text-muted text-right">% subs</th>
                <th className="px-3 py-3 font-medium text-muted">Risk</th>
                <th className="px-3 py-3 font-medium text-muted hidden lg:table-cell">
                  Recommended action
                </th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a, i) => {
                const k = a.customer.workspace_id ?? `${i}`;
                const isOpen = expanded.has(k);
                const isChecked = selected.has(k);
                const c = a.customer;
                const flagCodes = new Set(a.flags.map((f) => f.code));

                const lastSendDays = daysAgo(c.last_send);
                const lastSendCls = flagCodes.has("A")
                  ? "text-red-600 font-semibold"
                  : "text-muted";

                const lastLoginDays = daysAgo(c.last_log_in);
                const lastLoginCls = flagCodes.has("B")
                  ? "text-red-600 font-semibold"
                  : "text-muted";

                const subs = pctVal(c);
                const subsCls = flagCodes.has("C")
                  ? "text-red-600 font-semibold"
                  : subs != null && subs > 90
                    ? "text-amber-600"
                    : "text-muted";

                return (
                  <Fragment key={k}>
                    <tr
                      onClick={() => toggleExpanded(k)}
                      className={`border-b border-border align-top cursor-pointer transition-colors ${
                        isOpen ? "bg-blue-50 dark:bg-blue-500/40" : "hover:bg-blue-50 dark:bg-blue-500/30"
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
                          className="h-4 w-4 rounded border-border-strong cursor-pointer"
                          aria-label={`Select ${c.company_name ?? "row"}`}
                        />
                      </td>
                      <td className="px-3 py-3 text-subtle select-none">
                        <span
                          className={`inline-block transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        >
                          ▸
                        </span>
                      </td>
                      <td className="px-3 py-3 break-words">
                        <div className="font-medium text-fg">
                          {c.company_name ?? c.workspace_name}
                        </div>
                        <div className="text-xs text-muted truncate">
                          {c.customer_success_manager?.replace(/_/g, " ") ??
                            "unassigned"}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-medium">
                        {fmtCurrency(c.arr)}
                      </td>
                      <td className={`px-3 py-3 ${lastSendCls}`}>
                        <div>{fmtDate(c.last_send)}</div>
                        {lastSendDays != null ? (
                          <div className="text-xs text-muted">
                            {lastSendDays}d ago
                          </div>
                        ) : (
                          <div className="text-xs text-muted">never</div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {/* Compact badges per flag raised on this row. Sorted
                            by the canonical FLAG_META order (most-common
                            codes first) so the row reads consistently. Title
                            attribute carries the full per-flag description. */}
                        <div className="flex flex-wrap gap-1">
                          {FLAG_META.filter((m) => flagCodes.has(m.code)).map(
                            (m) => (
                              <span
                                key={m.code}
                                title={`${m.code} — ${m.label}: ${m.description}`}
                                className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  FLAG_COLORS[m.code] ?? "bg-surface-2 text-fg"
                                }`}
                              >
                                {m.code}
                              </span>
                            )
                          )}
                          {a.flags.length === 0 ? (
                            <span className="text-xs text-subtle italic">
                              —
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className={`px-3 py-3 ${lastLoginCls}`}>
                        {c.last_log_in ? (
                          <>
                            <div>{fmtDate(c.last_log_in)}</div>
                            {lastLoginDays != null ? (
                              <div className="text-xs text-muted">
                                {lastLoginDays}d ago
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="italic text-muted">14d+</span>
                        )}
                      </td>
                      {/* Last contacted — merges HubSpot's activity rollup
                       *  with the active CSM's Gmail (pre-fetched once per
                       *  page load via useGmailLastContact). A green
                       *  "Gmail" pill flags rows where Gmail beat HubSpot
                       *  so a CSM eyeballing the at-risk list sees at a
                       *  glance which rows might be wrongly flagged. */}
                      <td className="px-3 py-3 hidden lg:table-cell">
                        {(() => {
                          const lc = lastContacted(c, {
                            gmailDate: gmailDateFor(c),
                          });
                          if (!lc.date) {
                            return (
                              <span className="italic text-muted text-xs">
                                —
                              </span>
                            );
                          }
                          const days = daysAgo(lc.date);
                          return (
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span>{fmtDate(lc.date)}</span>
                                {lc.source === "gmail" ? (
                                  <span
                                    className="text-[9px] px-1 py-px rounded font-mono bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                                    title="Resolved from your Gmail mailbox — fresher than the HubSpot rollup."
                                  >
                                    G
                                  </span>
                                ) : null}
                              </div>
                              {days != null ? (
                                <div className="text-xs text-muted">
                                  {days}d ago
                                </div>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>
                      <td className={`px-3 py-3 text-right ${subsCls}`}>
                        <div>{fmtPct(subs)}</div>
                        {c.active_subs != null ? (
                          <div className="text-xs text-muted">
                            {fmtNumber(c.active_subs)}
                            {c.max_subscriptions != null
                              ? ` / ${fmtNumber(c.max_subscriptions)}`
                              : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <RiskLevelChip
                          level={c.property_risk_level}
                          detail={c.property_risk_level_detail}
                        />
                      </td>
                      <td className="px-3 py-3 text-fg text-xs break-words hidden lg:table-cell">
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
                      <tr className="bg-blue-50 dark:bg-blue-500/20 border-b border-border">
                        <td colSpan={12} className="px-6 py-4">
                          <CustomerDetailPanel
                            customer={c}
                            hideFeatureBreakdown
                            gmailDate={gmailDateFor(c)}
                            onGmailRefresh={
                              c.owner_email
                                ? () =>
                                    gmail.refresh(c.owner_email as string)
                                : undefined
                            }
                            gmailScopeMissing={gmail.scopeMissing}
                            topSlot={
                              <div className="space-y-3">
                                <div className="rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                                  <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300 mb-2">
                                    Why this account is flagged
                                  </h4>
                                  <ul className="space-y-1">
                                    {a.flags.map((f) => (
                                      <li
                                        key={f.code}
                                        className="text-sm text-fg"
                                      >
                                        <span
                                          className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold mr-2 ${
                                            FLAG_COLORS[f.code] ?? "bg-surface-2"
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

      <p className="text-xs text-subtle">
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
