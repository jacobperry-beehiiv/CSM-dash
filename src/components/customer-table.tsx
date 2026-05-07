"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import type { Customer, CustomerWithMetrics } from "@/lib/types";
import { StatusBadge } from "./status-badge";
import { RiskLevelChip } from "./risk-level-chip";
import { FilterBar } from "./filter-bar";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RowActions } from "./row-actions";
import { AdNetworkFilter } from "./ad-network-filter";
import { FeatureUtilizationFilter } from "./feature-utilization-filter";
import { fmtCompactCurrency, fmtDate, fmtNumber, daysUntil } from "./format";
import { featureCounts } from "@/lib/features";
import { composeUrlForTemplate, composeUrlWithAdGap } from "@/lib/links";
import type { StoredTemplate } from "@/lib/templates/store";
import type { AdGapReport } from "@/lib/types";
import { getTierLadder } from "@/lib/tiers/client";
import { applyMergeTags } from "@/lib/templates/merge-tags";
import { BulkDraftsModal, type BulkDraft } from "./bulk-drafts-modal";

type SortKey = keyof CustomerWithMetrics | "features_enabled";
type SortDir = "asc" | "desc";

interface ColumnDef {
  key: SortKey;
  label: string;
  /** Tailwind width % (uses table-fixed). Sums to <= ~94% (chevron+draft take ~6%). */
  width: string;
  align?: "right";
  /** Hide below this Tailwind breakpoint. md=768, lg=1024, xl=1280. */
  showAt?: "always" | "md" | "lg" | "xl";
}

const COLUMNS: ColumnDef[] = [
  { key: "company_name", label: "Company", width: "w-[20%]", showAt: "always" },
  { key: "arr", label: "ARR", width: "w-[8%]", align: "right", showAt: "always" },
  { key: "active_subs", label: "Subs", width: "w-[8%]", align: "right", showAt: "md" },
  { key: "features_enabled", label: "Features", width: "w-[8%]", align: "right", showAt: "lg" },
  { key: "company_engagement", label: "Engagement", width: "w-[9%]", showAt: "lg" },
  { key: "property_risk_level", label: "Risk", width: "w-[8%]", showAt: "md" },
  { key: "next_invoice", label: "Next charge", width: "w-[12%]", showAt: "md" },
  { key: "last_send", label: "Last send", width: "w-[8%]", showAt: "lg" },
  { key: "property_notes_last_contacted", label: "Last contacted", width: "w-[7%]", showAt: "xl" },
];

const SHOW_CLASS: Record<NonNullable<ColumnDef["showAt"]>, string> = {
  always: "table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

export function CustomerTable({
  initialCustomers,
  csms,
}: {
  initialCustomers: CustomerWithMetrics[];
  csms: string[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>("arr");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");
  const [adNetworkPredicate, setAdNetworkPredicate] = useState<
    ((c: Customer) => boolean) | null
  >(null);
  const [featurePredicate, setFeaturePredicate] = useState<
    ((c: Customer) => boolean) | null
  >(null);
  const [outreachFor, setOutreachFor] = useState<Customer | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkDrafts, setBulkDrafts] = useState<BulkDraft[]>([]);
  const [bulkTemplateLabel, setBulkTemplateLabel] = useState("");
  const [bulkProgress, setBulkProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const onAdNetworkFilterChange = useCallback(
    (predicate: ((c: Customer) => boolean) | null) => {
      setAdNetworkPredicate(() => predicate);
    },
    []
  );

  const onFeatureFilterChange = useCallback(
    (predicate: ((c: Customer) => boolean) | null) => {
      setFeaturePredicate(() => predicate);
    },
    []
  );

  const filtered = useMemo(() => {
    let list = initialCustomers;

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.company_name?.toLowerCase().includes(q) ||
          c.workspace_name?.toLowerCase().includes(q) ||
          c.property_main_contact?.toLowerCase().includes(q)
      );
    }
    if (adNetworkPredicate) {
      list = list.filter(adNetworkPredicate);
    }
    if (featurePredicate) {
      list = list.filter(featurePredicate);
    }

    list = [...list].sort((a, b) => {
      const av = pickSortValue(a, sortKey);
      const bv = pickSortValue(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const na = Number(av);
      const nb = Number(bv);
      return sortDir === "asc" ? na - nb : nb - na;
    });
    return list;
  }, [
    initialCustomers,
    search,
    adNetworkPredicate,
    featurePredicate,
    sortKey,
    sortDir,
  ]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function rowKey(c: CustomerWithMetrics, i: number): string {
    // Index suffix avoids React duplicate-key warnings when two snapshot rows
    // share a workspace_id (happens occasionally for shared workspaces).
    const id = c.workspace_id ?? c.stripe_customer_id ?? "row";
    return `${id}-${i}`;
  }

  // ─── Bulk-draft helpers ────────────────────────────────────────────
  /** Pick the template id auto-aligned with whichever filter is active. */
  function autoTemplateId(): string {
    if (adNetworkPredicate) return "ad-revenue-opportunity";
    if (featurePredicate) return "feature-not-using";
    return "general-checkin";
  }

  function htmlToText(html: string): string {
    return html
      .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>(?!\n)/gi, "\n")
      .replace(/<li[^>]*>/gi, "  • ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Pre-builds a draft for every selected customer and hands the list to
   * the modal. We don't open tabs from here — popup blockers kill all but
   * the first when window.open is called after an `await`. The modal opens
   * tabs synchronously inside its own click handler.
   */
  async function bulkDraft() {
    if (selected.size === 0) return;
    const filteredKeys = new Set(filtered.map((c, i) => rowKey(c, i)));
    const targets = filtered.filter((c, i) =>
      filteredKeys.has(rowKey(c, i)) && selected.has(rowKey(c, i))
    );
    if (targets.length === 0) {
      setBulkMessage("No selected customers in the current filtered view.");
      return;
    }

    setBulkBusy(true);
    setBulkMessage(null);
    setBulkError(null);
    setBulkDrafts([]);
    setBulkProgress({ done: 0, total: targets.length });
    setBulkModalOpen(true);

    try {
      const [templates, ladder] = await Promise.all([
        fetch("/api/templates").then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as StoredTemplate[];
        }),
        getTierLadder().catch(() => []),
      ]);
      const wantedId = autoTemplateId();
      const tpl =
        templates.find((t) => t.id === wantedId) ??
        templates.find((t) => t.id === "general-checkin") ??
        templates[0];
      if (!tpl) {
        setBulkError("No templates available — visit /settings/templates.");
        return;
      }
      setBulkTemplateLabel(tpl.label);

      const usesAdGap = /customer\.(ad_revenue_actual|ad_revenue_potential|ad_revenue_gap|ad_zero_pubs)/.test(
        tpl.subject + tpl.body_html
      );

      // Pre-fetch ad-gap reports if the template needs them (concurrency 4).
      let adGapByOrg: Record<string, AdGapReport | null> = {};
      if (usesAdGap) {
        const today = new Date().toISOString().slice(0, 10);
        const start = new Date(Date.now() - 90 * 86400_000)
          .toISOString()
          .slice(0, 10);
        const queue = targets
          .map((c) => c.workspace_id)
          .filter((id): id is string => Boolean(id));

        const results = new Map<string, AdGapReport | null>();
        let cursor = 0;
        let completed = 0;
        async function worker() {
          while (cursor < queue.length) {
            const idx = cursor++;
            const id = queue[idx];
            try {
              const r = await fetch(
                `/api/ad-gap?organization_id=${encodeURIComponent(id)}&start=${start}&end=${today}`
              );
              const j = await r.json();
              results.set(id, j?.report ?? null);
            } catch {
              results.set(id, null);
            }
            completed++;
            setBulkProgress({ done: completed, total: queue.length });
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(4, queue.length) }, () => worker())
        );
        adGapByOrg = Object.fromEntries(results);
      }

      const drafts: BulkDraft[] = [];
      for (const c of targets) {
        if (!c.owner_email) continue;
        const adGap = c.workspace_id ? adGapByOrg[c.workspace_id] ?? null : null;
        const composeUrl =
          usesAdGap && adGap
            ? composeUrlWithAdGap(tpl, c, ladder, adGap)
            : composeUrlForTemplate(tpl, c, ladder);
        if (!composeUrl) continue;
        const ctx = { ladder, adGap };
        const subject = applyMergeTags(tpl.subject, c, ctx);
        const body_html = applyMergeTags(tpl.body_html, c, ctx);
        const body_text = htmlToText(body_html);
        drafts.push({
          customer_label: c.company_name ?? c.workspace_name ?? c.owner_email,
          to: c.owner_email,
          subject,
          body_text,
          body_html,
          compose_url: composeUrl,
        });
      }
      setBulkDrafts(drafts);
      setBulkProgress(null);

      if (drafts.length === 0) {
        setBulkError(
          "No drafts generated — selected accounts may be missing owner emails."
        );
      }
    } catch (e) {
      setBulkError(
        `Bulk draft failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderCell(c: CustomerWithMetrics, key: SortKey) {
    switch (key) {
      case "company_name":
        return (
          <div className="min-w-0">
            <div className="font-medium text-gray-900 break-words">
              {c.company_name || c.workspace_name || "-"}
            </div>
            <div className="text-xs text-gray-500 truncate">
              {c.workspace_name || ""}
            </div>
          </div>
        );
      case "arr":
        return fmtCompactCurrency(c.arr);
      case "active_subs":
        return fmtNumber(c.active_subs);
      case "features_enabled": {
        const { active, total } = featureCounts(c);
        const ratio = active / total;
        const color =
          ratio < 0.34
            ? "text-red-600"
            : ratio < 0.67
              ? "text-amber-600"
              : "text-emerald-700";
        return (
          <span className={`font-medium ${color}`}>
            {active}/{total}
          </span>
        );
      }
      case "company_engagement":
        return <StatusBadge value={c.company_engagement} />;
      case "property_risk_level":
        return (
          <RiskLevelChip
            level={c.property_risk_level}
            detail={c.property_risk_level_detail}
          />
        );
      case "next_invoice": {
        const date = c.next_invoice ?? c.renewal_date;
        const days = daysUntil(date);
        const color =
          days != null && days <= 7
            ? "text-red-600 font-semibold"
            : days != null && days <= 30
              ? "text-amber-600"
              : "";
        const cadence = (c.interval ?? "").toLowerCase();
        const cadenceLabel = cadence === "annual"
          ? "annual"
          : cadence === "month" || cadence === "monthly"
            ? "monthly"
            : cadence || null;
        const cadenceClass =
          cadenceLabel === "annual"
            ? "bg-purple-100 text-purple-800 border-purple-200"
            : cadenceLabel === "monthly"
              ? "bg-sky-100 text-sky-800 border-sky-200"
              : "bg-gray-100 text-gray-700 border-gray-200";
        return (
          <div className="flex flex-col gap-0.5">
            <span className={color}>{fmtDate(date)}</span>
            {cadenceLabel ? (
              <span
                className={`inline-block w-fit px-1.5 py-0.5 rounded text-[10px] font-medium border ${cadenceClass}`}
              >
                {cadenceLabel}
              </span>
            ) : null}
          </div>
        );
      }
      case "last_send":
        return (
          <span className="text-gray-600 text-xs">{fmtDate(c.last_send)}</span>
        );
      case "property_notes_last_contacted":
        return (
          <span className="text-gray-600 text-xs">
            {fmtDate(c.property_notes_last_contacted ?? null)}
          </span>
        );
      default:
        return "-";
    }
  }

  return (
    <>
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        csms={csms}
      />

      <div className="space-y-3 mb-4">
        <FeatureUtilizationFilter
          customers={initialCustomers}
          onFilterChange={onFeatureFilterChange}
        />
        <AdNetworkFilter
          customers={initialCustomers}
          onFilterChange={onAdNetworkFilterChange}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2 mb-3 bg-gray-50 border border-gray-200 rounded-md">
        <span className="text-xs text-gray-600">
          <strong>{selected.size}</strong> selected of {filtered.length}
        </span>
        <button
          onClick={() => {
            const allKeys = filtered.map((c, i) => rowKey(c, i));
            const allSelected = allKeys.every((k) => selected.has(k));
            setSelected(allSelected ? new Set() : new Set(allKeys));
          }}
          className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white hover:bg-gray-50"
        >
          {filtered.length > 0 &&
          filtered.every((c, i) => selected.has(rowKey(c, i)))
            ? "Deselect all visible"
            : "Select all visible"}
        </button>
        <button
          onClick={() => setSelected(new Set())}
          disabled={selected.size === 0}
          className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          Clear
        </button>
        <span className="text-xs text-gray-500 ml-2">
          Template auto-pick:{" "}
          <code className="font-mono bg-white border border-gray-200 px-1 rounded">
            {adNetworkPredicate
              ? "ad-revenue-opportunity"
              : featurePredicate
                ? "feature-not-using"
                : "general-checkin"}
          </code>
        </span>
        <div className="flex-1" />
        <button
          onClick={bulkDraft}
          disabled={bulkBusy || selected.size === 0}
          className="px-3 py-1 text-xs bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-50"
        >
          {bulkBusy
            ? "Drafting…"
            : `✉️ Draft for ${selected.size}${selected.size === 1 ? "" : ""}`}
        </button>
      </div>
      {bulkMessage ? (
        <div className="text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded-md px-3 py-2 mb-3">
          {bulkMessage}
        </div>
      ) : null}
      <div className="rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-8" />
            <col className="w-8" />
            {COLUMNS.map((c) => (
              <col key={c.key} className={`${c.width} ${SHOW_CLASS[c.showAt ?? "always"]}`} />
            ))}
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-3 w-8"></th>
              <th className="px-3 py-3 w-8"></th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className={`px-3 py-3 font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${SHOW_CLASS[col.showAt ?? "always"]}`}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1">
                      {sortDir === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </th>
              ))}
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c, i) => {
              const k = rowKey(c, i);
              const isOpen = expanded.has(k);
              return (
                <Fragment key={k}>
                  <tr
                    onClick={() => toggleExpanded(k)}
                    className={`border-b border-gray-100 cursor-pointer transition-colors align-top ${
                      isOpen ? "bg-blue-50/40" : "hover:bg-blue-50/30"
                    }`}
                  >
                    <td
                      className="px-3 py-2.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(k)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          })
                        }
                        className="h-4 w-4 rounded border-gray-300 cursor-pointer"
                        aria-label={`Select ${c.company_name ?? "row"}`}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-gray-400 select-none">
                      <span
                        className={`inline-block transition-transform ${
                          isOpen ? "rotate-90" : ""
                        }`}
                      >
                        ▸
                      </span>
                    </td>
                    {COLUMNS.map((col) => (
                      <td
                        key={col.key}
                        className={`px-3 py-2.5 ${
                          col.align === "right" ? "text-right" : ""
                        } ${SHOW_CLASS[col.showAt ?? "always"]}`}
                      >
                        {renderCell(c, col.key)}
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-right">
                      <RowActions customer={c} onDraft={setOutreachFor} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-blue-50/20 border-b border-gray-100">
                      <td colSpan={COLUMNS.length + 3} className="px-6 py-4">
                        <CustomerDetailPanel customer={c} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center text-gray-500 py-8">
            No customers match your filters
          </div>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Showing {filtered.length} of {initialCustomers.length} customers · click a
        row to expand feature usage
      </p>
      {outreachFor && (
        <OutreachModal customer={outreachFor} onClose={() => setOutreachFor(null)} />
      )}
      {bulkModalOpen ? (
        <BulkDraftsModal
          templateLabel={bulkTemplateLabel}
          drafts={bulkDrafts}
          loading={bulkBusy}
          loadingProgress={bulkProgress}
          error={bulkError}
          onClose={() => setBulkModalOpen(false)}
        />
      ) : null}
    </>
  );
}

function pickSortValue(c: CustomerWithMetrics, key: SortKey): unknown {
  if (key === "features_enabled") return featureCounts(c).active;
  return c[key as keyof CustomerWithMetrics];
}
