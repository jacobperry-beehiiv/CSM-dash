"use client";

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Customer, CustomerWithMetrics } from "@/lib/types";
import { StatusBadge } from "./status-badge";
import { RiskLevelChip } from "./risk-level-chip";
import { FilterBar, SearchInput, SelectFilter } from "./filters";
import { CsmSelector } from "./csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import { MetricCards } from "./metric-cards";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RowActions } from "./row-actions";
import { FeatureUtilizationFilter } from "./feature-utilization-filter";
import { fmtCurrency, fmtDate, fmtNumber, daysUntil } from "./format";
import { featureCounts } from "@/lib/features";
import { lastContacted } from "@/lib/customer-helpers";
import { useGmailLastContact } from "@/lib/hooks/use-gmail-last-contact";
import { isVisibleToCsm } from "@/lib/templates/types";
import { useViewerEmail } from "@/lib/auth-client";
import type { StoredTemplate } from "@/lib/templates/types";
import type { AdGapReport } from "@/lib/types";
import { getTierLadder } from "@/lib/tiers/client";
import { buildBulkDrafts } from "@/lib/templates/bulk-drafts";
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

// Column widths sized so the data columns + the (now stacked) Actions
// cluster sum to ~100%. Stacking the action buttons vertically dropped
// the actions column from 20% → 11%, freeing room to give the
// Engagement chip + CSM name + Last-contacted date proper breathing
// room. Headers (e.g. "Engagement") use whitespace-nowrap below to
// avoid wrapping; cells get overflow-hidden so any over-long content
// gets clipped instead of bleeding into the next column.
const COLUMNS: ColumnDef[] = [
  { key: "company_name", label: "Company", width: "w-[17%]", showAt: "always" },
  { key: "arr", label: "ARR", width: "w-[7%]", align: "right", showAt: "always" },
  { key: "active_subs", label: "Subs", width: "w-[7%]", align: "right", showAt: "md" },
  { key: "features_enabled", label: "Features", width: "w-[7%]", align: "right", showAt: "lg" },
  // Engagement bumped 8 → 10 so "Medium Touch" no longer bleeds the
  // header / pill into the CSM cell.
  { key: "company_engagement", label: "Engagement", width: "w-[10%]", showAt: "lg" },
  // CSM bumped 8 → 10 so "Jacob Perry" (and similar) stays on one
  // line. Lives next to Engagement because both answer "who/what
  // owns this account?". Stays in sync with the customer-overrides
  // KV — a "🔄 HubSpot" refresh on the detail panel propagates
  // through here on the next router.refresh() tick.
  {
    key: "customer_success_manager",
    label: "CSM",
    width: "w-[10%]",
    showAt: "lg",
  },
  { key: "property_risk_level", label: "Risk", width: "w-[8%]", showAt: "md" },
  { key: "next_invoice", label: "Next charge", width: "w-[8%]", showAt: "md" },
  { key: "last_send", label: "Last send", width: "w-[7%]", showAt: "lg" },
  // 8% comfortably fits "Jan 27, 2026" on one line at every viewport
  // we render at.
  { key: "property_notes_last_contacted", label: "Last contacted", width: "w-[8%]", showAt: "xl" },
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
  const viewerEmail = useViewerEmail();
  const router = useRouter();

  // Gmail-direct "Last contacted" overlay. Batches one POST per page
  // load using the active CSM's Gmail token. Results merge into
  // lastContacted() per row via the new gmailDate option. Failure
  // modes (no active Gmail, missing scope, network blip) are
  // non-fatal — the column falls back to HubSpot values.
  const ownerEmailList = useMemo(
    () =>
      initialCustomers
        .map((c) => c.owner_email ?? "")
        .filter((e): e is string => Boolean(e)),
    [initialCustomers]
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

  // CSM sweep state. The sweep batches HubSpot owner lookups across
  // the entire book and writes customer-overrides for any reassigned
  // rows — see /api/customer-overrides/refresh-all-csms.
  const [csmSweepBusy, setCsmSweepBusy] = useState(false);
  const [csmSweepMessage, setCsmSweepMessage] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("arr");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useUrlSearch("q");
  // Lifecycle filter: q10600 already restricts to Live + Onboarding,
  // so those are the only two values that show up in the book. The
  // empty/"All" option leaves both showing. Synced to the URL so the
  // viewer can deep-link a status-scoped view.
  const [statusFilter, setStatusFilter] = useUrlSearch("status");
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
  const [bulkTemplates, setBulkTemplates] = useState<StoredTemplate[]>([]);
  const [bulkTemplateId, setBulkTemplateId] = useState<string>("");
  const [bulkTargets, setBulkTargets] = useState<CustomerWithMetrics[]>([]);
  const [bulkLadder, setBulkLadder] = useState<
    Awaited<ReturnType<typeof getTierLadder>>
  >([]);
  const [bulkProgress, setBulkProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const onFeatureFilterChange = useCallback(
    (predicate: ((c: Customer) => boolean) | null) => {
      setFeaturePredicate(() => predicate);
    },
    []
  );

  // Publication-index for the search input. Lazy + cached so the page
  // load isn't blocked on it — a search term entered before the fetch
  // resolves still matches against name/workspace fields, just not
  // against pub IDs.
  const { ws2pubs } = usePublicationsIndex();

  const filtered = useMemo(() => {
    let list = initialCustomers;

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((c) => {
        // Pub IDs owned by this workspace, so pasting a pub_… UUID
        // finds the company without the user needing to know which
        // shape of ID they're holding.
        const pubs = c.workspace_id ? ws2pubs[c.workspace_id] ?? [] : [];
        // CSM names are stored snake_cased (e.g. "olivia_chen"). Match
        // against the underscore form AND a humanized "olivia chen"
        // form so "Olivia" or "olivia chen" both find the row.
        const csmRaw = c.customer_success_manager ?? null;
        const csmHuman = csmRaw?.replace(/_/g, " ") ?? null;
        if (
          c.company_name?.toLowerCase().includes(q) ||
          c.workspace_name?.toLowerCase().includes(q) ||
          c.property_main_contact?.toLowerCase().includes(q) ||
          c.workspace_id?.toLowerCase().includes(q) ||
          c.stripe_customer_id?.toLowerCase().includes(q) ||
          c.owner_email?.toLowerCase().includes(q) ||
          csmRaw?.toLowerCase().includes(q) ||
          csmHuman?.toLowerCase().includes(q)
        ) {
          return true;
        }
        return pubs.some((p) => p.toLowerCase().includes(q));
      });
    }
    if (featurePredicate) {
      list = list.filter(featurePredicate);
    }
    if (statusFilter) {
      const target = statusFilter.toLowerCase();
      list = list.filter(
        (c) => (c.property_company_status ?? "").toLowerCase() === target
      );
    }

    list = [...list].sort((a, b) => {
      const av = pickSortValue(a, sortKey, {
        gmailDateFor: (c) => gmailDateFor(c),
      });
      const bv = pickSortValue(b, sortKey, {
        gmailDateFor: (c) => gmailDateFor(c),
      });
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
    featurePredicate,
    statusFilter,
    sortKey,
    sortDir,
    ws2pubs,
    gmailDateFor,
  ]);

  // Counts shown next to each option in the lifecycle dropdown so the
  // viewer sees how many rows each filter would yield. Derived from
  // the full book (ignoring the active status filter), so the counts
  // stay stable as the user toggles.
  const statusCounts = useMemo(() => {
    const counts: { live: number; onboarding: number } = { live: 0, onboarding: 0 };
    for (const c of initialCustomers) {
      const s = (c.property_company_status ?? "").toLowerCase();
      if (s === "live") counts.live++;
      else if (s === "onboarding") counts.onboarding++;
    }
    return counts;
  }, [initialCustomers]);

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
    if (featurePredicate) return "feature-not-using";
    return "general-checkin";
  }

  function csvEscape(v: unknown): string {
    if (v == null) return "";
    return `"${String(v).replace(/"/g, '""')}"`;
  }

  /** Export the currently-filtered list to a CSV download. */
  function exportFilteredCsv() {
    if (filtered.length === 0) return;
    const columns: Array<{ header: string; pick: (c: CustomerWithMetrics) => unknown }> = [
      { header: "Company", pick: (c) => c.company_name ?? "" },
      { header: "Workspace", pick: (c) => c.workspace_name ?? "" },
      { header: "Workspace ID", pick: (c) => c.workspace_id ?? "" },
      { header: "CSM", pick: (c) => c.customer_success_manager ?? "" },
      { header: "Owner email", pick: (c) => c.owner_email ?? "" },
      { header: "Plan", pick: (c) => c.stripe_plan ?? "" },
      { header: "Cadence", pick: (c) => c.interval ?? "" },
      { header: "ARR", pick: (c) => c.arr ?? 0 },
      { header: "MRR", pick: (c) => c.mrr ?? 0 },
      { header: "Active subs", pick: (c) => c.active_subs ?? 0 },
      { header: "Max subs", pick: (c) => c.max_subscriptions ?? "" },
      {
        header: "% of tier",
        pick: (c) =>
          c.utilization_pct == null ? "" : `${c.utilization_pct.toFixed(1)}%`,
      },
      { header: "Renewal date", pick: (c) => c.renewal_date ?? "" },
      { header: "Next charge", pick: (c) => c.next_invoice ?? c.renewal_date ?? "" },
      { header: "Last send", pick: (c) => c.last_send ?? "" },
      { header: "Last log in", pick: (c) => c.last_log_in ?? "" },
      { header: "Last contacted", pick: (c) => lastContacted(c).date ?? "" },
      { header: "Last contacted source", pick: (c) => lastContacted(c).source },
      { header: "Risk level", pick: (c) => c.property_risk_level ?? "" },
      { header: "Risk detail", pick: (c) => c.property_risk_level_detail ?? "" },
      { header: "Engagement", pick: (c) => c.company_engagement ?? "" },
    ];
    const header = columns.map((col) => csvEscape(col.header)).join(",");
    const rows = filtered.map((c) =>
      columns.map((col) => csvEscape(col.pick(c))).join(",")
    );
    const ts = new Date().toISOString().slice(0, 10);
    const blob = new Blob(["﻿" + [header, ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `csm-book-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Cache per-org ad-gap reports across template re-renders so swapping
  // templates inside the modal doesn't re-hit the API. Cleared each time
  // bulkDraft() opens the modal fresh.
  const adGapCacheRef = useRef<Record<string, AdGapReport | null>>({});

  async function fetchAdGapForTargets(
    targets: CustomerWithMetrics[]
  ): Promise<Record<string, AdGapReport | null>> {
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 90 * 86400_000)
      .toISOString()
      .slice(0, 10);
    const cache = adGapCacheRef.current;
    const queue = targets
      .map((c) => c.workspace_id)
      .filter((id): id is string => Boolean(id))
      .filter((id) => !(id in cache));

    if (queue.length === 0) return cache;

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
          cache[id] = j?.report ?? null;
        } catch {
          cache[id] = null;
        }
        completed++;
        setBulkProgress({ done: completed, total: queue.length });
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, () => worker())
    );
    return cache;
  }

  async function buildDraftsFor(
    tpl: StoredTemplate,
    targets: CustomerWithMetrics[],
    ladder: Awaited<ReturnType<typeof getTierLadder>>
  ): Promise<BulkDraft[]> {
    const usesAdGap = /customer\.(ad_revenue_actual|ad_revenue_potential|ad_revenue_gap|ad_zero_pubs)/.test(
      tpl.subject + tpl.body_html
    );
    const adGapByOrg = usesAdGap ? await fetchAdGapForTargets(targets) : {};
    return buildBulkDrafts({
      targets,
      template: tpl,
      ladder,
      adGapByOrg,
    });
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

    adGapCacheRef.current = {};
    setBulkBusy(true);
    setBulkMessage(null);
    setBulkError(null);
    setBulkDrafts([]);
    setBulkTargets(targets);
    setBulkProgress({ done: 0, total: targets.length });
    setBulkModalOpen(true);

    try {
      const [allTemplates, ladder] = await Promise.all([
        fetch("/api/templates").then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as StoredTemplate[];
        }),
        getTierLadder().catch(() => []),
      ]);
      // Narrow to templates this CSM is allowed to see. Universal
      // (no csm_tags) templates remain visible to everyone.
      const templates = allTemplates.filter((t) =>
        isVisibleToCsm(t, viewerEmail)
      );
      setBulkTemplates(templates);
      setBulkLadder(ladder);
      const wantedId = autoTemplateId();
      const tpl =
        templates.find((t) => t.id === wantedId) ??
        templates.find((t) => t.id === "general-checkin") ??
        templates[0];
      if (!tpl) {
        setBulkError("No templates available — visit /settings/templates.");
        return;
      }
      setBulkTemplateId(tpl.id);

      const drafts = await buildDraftsFor(tpl, targets, ladder);
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

  /** Re-render every draft against a different template (in-modal swap). */
  async function changeBulkTemplate(nextId: string) {
    if (nextId === bulkTemplateId) return;
    const tpl = bulkTemplates.find((t) => t.id === nextId);
    if (!tpl) return;
    setBulkTemplateId(nextId);
    setBulkBusy(true);
    setBulkError(null);
    setBulkProgress({ done: 0, total: bulkTargets.length });
    try {
      const drafts = await buildDraftsFor(tpl, bulkTargets, bulkLadder);
      setBulkDrafts(drafts);
      if (drafts.length === 0) {
        setBulkError(
          "No drafts generated — selected accounts may be missing owner emails."
        );
      }
    } catch (e) {
      setBulkError(
        `Re-render failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setBulkProgress(null);
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
            <div className="font-medium text-fg break-words">
              {c.company_name || c.workspace_name || "-"}
            </div>
            <div className="text-xs text-muted truncate">
              {c.workspace_name || ""}
            </div>
          </div>
        );
      case "arr":
        return fmtCurrency(c.arr);
      case "active_subs":
        // Two-line shape matching the AM panels: active count on top,
        // muted "/ cap" below. Gives the reader the % of plan they
        // need to eyeball without a separate column. Falls back to a
        // single dash when both are null.
        if (c.active_subs == null && c.max_subscriptions == null) return "—";
        return (
          <div className="leading-tight">
            <div>{fmtNumber(c.active_subs)}</div>
            {c.max_subscriptions != null ? (
              <div className="text-xs text-muted">
                / {fmtNumber(c.max_subscriptions)}
              </div>
            ) : null}
          </div>
        );
      case "features_enabled": {
        const { active, total } = featureCounts(c);
        const ratio = active / total;
        const color =
          ratio < 0.34
            ? "text-red-600"
            : ratio < 0.67
              ? "text-amber-600"
              : "text-emerald-700 dark:text-emerald-300";
        return (
          <span className={`font-medium ${color}`}>
            {active}/{total}
          </span>
        );
      }
      case "company_engagement":
        return <StatusBadge value={c.company_engagement} />;
      case "customer_success_manager":
        // Snake-cased identifier → "Jacob Perry" reads cleaner inline.
        // Empty cell when unassigned so the column doesn't shout "-"
        // on every self-serve row in the book.
        return c.customer_success_manager ? (
          <span className="text-muted text-xs">
            {c.customer_success_manager.replace(/_/g, " ")}
          </span>
        ) : (
          <span className="text-subtle text-xs italic">unassigned</span>
        );
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
              : "bg-surface-2 text-muted border-border";
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
          <span className="text-muted text-xs">{fmtDate(c.last_send)}</span>
        );
      case "property_notes_last_contacted": {
        // Resolve max(HubSpot activity rollup, notes_last_contacted,
        // Gmail). Gmail overlay comes from the per-CSM /api/last-
        // contact/gmail batch fetched on mount. The legacy column key
        // is preserved so the existing sort still works.
        const lc = lastContacted(c, { gmailDate: gmailDateFor(c) });
        return (
          <span
            className="text-muted text-xs"
            title={
              lc.date
                ? `Source: ${lc.source}`
                : "No activity recorded across HubSpot or Gmail"
            }
          >
            {fmtDate(lc.date)}
          </span>
        );
      }
      default:
        return "-";
    }
  }

  return (
    <>
      {gmail.scopeMissing ? (
        <div className="mb-4 px-4 py-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-200 text-sm flex items-center gap-3">
          <span aria-hidden>🔄</span>
          <span className="flex-1">
            Reconnect Gmail to enable Gmail-source contact dates — the
            "Last contacted" column will pull from your actual sent /
            received mail instead of HubSpot's activity rollup.
          </span>
          <a
            href="/settings/gmail"
            className="text-amber-900 dark:text-amber-100 underline hover:no-underline font-medium"
          >
            Open settings →
          </a>
        </div>
      ) : null}
      <MetricCards customers={filtered} />
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name, owner, CSM, workspace / publication ID…"
        />
        <CsmSelector csms={csms} />
        <SelectFilter
          label="Status"
          value={statusFilter}
          onChange={setStatusFilter}
          emptyLabel="All"
          emptyCount={statusCounts.live + statusCounts.onboarding}
          options={[
            { value: "Live", label: "Live", count: statusCounts.live },
            {
              value: "Onboarding",
              label: "Onboarding",
              count: statusCounts.onboarding,
            },
          ]}
        />
      </FilterBar>

      <div className="space-y-3 mb-4">
        <FeatureUtilizationFilter
          customers={initialCustomers}
          onFilterChange={onFeatureFilterChange}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2 mb-3 bg-canvas border border-border rounded-md">
        <span className="text-xs text-muted">
          <strong>{selected.size}</strong> selected of {filtered.length}
        </span>
        <button
          onClick={() => {
            const allKeys = filtered.map((c, i) => rowKey(c, i));
            const allSelected = allKeys.every((k) => selected.has(k));
            setSelected(allSelected ? new Set() : new Set(allKeys));
          }}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        >
          {filtered.length > 0 &&
          filtered.every((c, i) => selected.has(rowKey(c, i)))
            ? "Deselect all visible"
            : "Select all visible"}
        </button>
        <button
          onClick={() => setSelected(new Set())}
          disabled={selected.size === 0}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
        >
          Clear
        </button>
        <span className="text-xs text-muted ml-2">
          Template auto-pick:{" "}
          <code className="font-mono bg-surface border border-border px-1 rounded">
            {featurePredicate ? "feature-not-using" : "general-checkin"}
          </code>
        </span>
        <div className="flex-1" />
        <button
          onClick={async () => {
            setCsmSweepBusy(true);
            setCsmSweepMessage(null);
            try {
              const r = await fetch(
                "/api/customer-overrides/refresh-all-csms",
                { method: "POST" }
              );
              const j = (await r.json()) as {
                scanned?: number;
                changed?: number;
                unchanged?: number;
                no_hubspot_company_id?: number;
                no_owner_in_hubspot?: number;
                truncated?: boolean;
                error?: string;
              };
              if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
              const parts: string[] = [];
              parts.push(`${j.changed ?? 0} reassigned`);
              parts.push(`${j.unchanged ?? 0} unchanged`);
              if (j.no_owner_in_hubspot)
                parts.push(`${j.no_owner_in_hubspot} unassigned in HubSpot`);
              if (j.no_hubspot_company_id)
                parts.push(`${j.no_hubspot_company_id} unmatched`);
              setCsmSweepMessage(
                `HubSpot CSM sweep — scanned ${j.scanned ?? 0}: ${parts.join(", ")}.`
              );
              if ((j.changed ?? 0) > 0) {
                // Re-run server components so the new overrides land
                // in the CSM column, the filter dropdown, the search
                // haystack, and every other CSM-aware surface.
                router.refresh();
              }
            } catch (e) {
              setCsmSweepMessage(
                `Sweep failed: ${e instanceof Error ? e.message : "unknown"}`
              );
            } finally {
              setCsmSweepBusy(false);
              // Clear the message after a beat — long enough to read
              // the counts but not so long it stays around between
              // unrelated workflows.
              setTimeout(() => setCsmSweepMessage(null), 12_000);
            }
          }}
          disabled={csmSweepBusy}
          className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-surface-2 disabled:opacity-50"
          title="Pull every customer's current HubSpot owner and write overrides for any reassignments — closes the gap between a HubSpot edit and the dashboard reflecting it, without waiting for the nightly Metabase sync."
        >
          {csmSweepBusy ? "Refreshing CSMs…" : "🔄 Refresh CSMs from HubSpot"}
        </button>
        <button
          onClick={exportFilteredCsv}
          disabled={filtered.length === 0}
          className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-surface-2 disabled:opacity-50"
          title="Download the current filtered list as a CSV"
        >
          ⬇ Export {filtered.length} to CSV
        </button>
        <button
          onClick={bulkDraft}
          disabled={bulkBusy || selected.size === 0}
          className="px-3 py-1 text-xs bg-accent text-accent-fg rounded-md hover:bg-accent-hover disabled:opacity-50"
        >
          {bulkBusy
            ? "Drafting…"
            : `✉️ Draft for ${selected.size}${selected.size === 1 ? "" : ""}`}
        </button>
      </div>
      {bulkMessage ? (
        <div className="text-xs text-muted bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-accent/30 rounded-md px-3 py-2 mb-3">
          {bulkMessage}
        </div>
      ) : null}
      {csmSweepMessage ? (
        <div className="text-xs text-muted bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-md px-3 py-2 mb-3">
          {csmSweepMessage}
        </div>
      ) : null}
      <div className="rounded-xl border border-border bg-surface shadow-card">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-8" />
            <col className="w-8" />
            {COLUMNS.map((c) => (
              <col key={c.key} className={`${c.width} ${SHOW_CLASS[c.showAt ?? "always"]}`} />
            ))}
            {/* Actions column. RowActions now stacks Masquerade /
             *  HubSpot / Draft vertically, so the column only has to
             *  fit the widest button (~110px). 11% covers that
             *  comfortably at every breakpoint we render at, and the
             *  freed real estate went back into Engagement / CSM /
             *  Last contacted above. */}
            <col className="w-[11%]" />
          </colgroup>
          <thead>
            <tr className="bg-canvas border-b border-border">
              <th className="px-3 py-3 w-8"></th>
              <th className="px-3 py-3 w-8"></th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  // overflow-hidden + whitespace-nowrap: with
                  // table-fixed, a too-long header would otherwise
                  // bleed into the next cell (e.g. "EngagementCSM"
                  // smashed together). Clip instead.
                  className={`px-3 py-3 font-medium text-muted cursor-pointer hover:bg-surface-2 select-none overflow-hidden whitespace-nowrap text-ellipsis ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${SHOW_CLASS[col.showAt ?? "always"]}`}
                  title={col.label}
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
                    className={`border-b border-border cursor-pointer transition-colors align-top ${
                      isOpen ? "bg-blue-50 dark:bg-blue-500/40" : "hover:bg-blue-50 dark:bg-blue-500/30"
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
                        className="h-4 w-4 rounded border-border-strong cursor-pointer"
                        aria-label={`Select ${c.company_name ?? "row"}`}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-subtle select-none">
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
                        // overflow-hidden so a too-wide chip (e.g.
                        // "Medium Touch") doesn't bleed into the
                        // adjacent column visually. Individual cell
                        // renderers can still opt-in to multi-line
                        // layouts (Company, Next charge) — their
                        // outer wrappers govern wrapping.
                        className={`px-3 py-2.5 overflow-hidden ${
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
                    <tr className="bg-blue-50 dark:bg-blue-500/20 border-b border-border">
                      <td colSpan={COLUMNS.length + 3} className="px-6 py-4">
                        <CustomerDetailPanel
                          customer={c}
                          showPaidSubs
                          gmailDate={gmailDateFor(c)}
                          gmailMatch={
                            c.owner_email
                              ? gmail.matchMap[
                                  c.owner_email.trim().toLowerCase()
                                ] ?? null
                              : null
                          }
                          onGmailRefresh={
                            c.owner_email
                              ? () =>
                                  gmail.refresh(c.owner_email as string)
                              : undefined
                          }
                          gmailScopeMissing={gmail.scopeMissing}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center text-muted py-8">
            No customers match your filters
          </div>
        )}
      </div>
      <p className="text-xs text-subtle mt-2">
        Showing {filtered.length} of {initialCustomers.length} customers · click a
        row to expand feature usage
      </p>
      {outreachFor && (
        <OutreachModal customer={outreachFor} onClose={() => setOutreachFor(null)} />
      )}
      {bulkModalOpen ? (
        <BulkDraftsModal
          templates={bulkTemplates.map((t) => ({ id: t.id, label: t.label }))}
          templateId={bulkTemplateId}
          onTemplateChange={changeBulkTemplate}
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

function pickSortValue(
  c: CustomerWithMetrics,
  key: SortKey,
  opts?: { gmailDateFor?: (c: Customer) => string | undefined }
): unknown {
  if (key === "features_enabled") return featureCounts(c).active;
  // Sort the "Last contacted" column by the merged date — including
  // the Gmail overlay when the parent passed gmailDateFor — so what
  // the user sees and sorts on match.
  if (key === "property_notes_last_contacted") {
    return lastContacted(c, { gmailDate: opts?.gmailDateFor?.(c) }).date;
  }
  return c[key as keyof CustomerWithMetrics];
}
