"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Customer, CustomerWithMetrics } from "@/lib/types";
import { StatusBadge } from "./status-badge";
import { RiskLevelChip } from "./risk-level-chip";
import { FilterBar, SearchInput, SelectFilter, MultiSelectFilter } from "./filters";
import { CsmSelector } from "./csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import { MetricCards } from "./metric-cards";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { RowActions } from "./row-actions";
import {
  FeatureUtilizationFilter,
  type WorkspaceFeatureMatcher,
} from "./feature-utilization-filter";
import { fmtCurrency, fmtDate, fmtNumber, daysUntil } from "./format";
import { featureCounts } from "@/lib/features";
import {
  cadenceBadgeClass,
  cadenceRowLabel,
  intervalBucket,
  lastContacted,
} from "@/lib/customer-helpers";
import { useGmailLastContact } from "@/lib/hooks/use-gmail-last-contact";
import {
  useColumnVisibility,
  type ColumnDef as VisibilityColumnDef,
} from "@/lib/hooks/use-column-visibility";
import { ColumnPicker } from "./column-picker";
import { isVisibleToCsm } from "@/lib/templates/types";
import { useViewerEmail } from "@/lib/auth-client";
import type { StoredTemplate } from "@/lib/templates/types";
import type { AdGapReport } from "@/lib/types";
import { getTierLadder } from "@/lib/tiers/client";
import { buildBulkDrafts } from "@/lib/templates/bulk-drafts";
import { useCustomMergeTags } from "@/lib/data/use-custom-merge-tags";
import { BulkDraftsModal, type BulkDraft } from "./bulk-drafts-modal";
import { MappedFieldEditor } from "./mapped-field-editor";
import { MAPPABLE_DASHBOARD_FIELDS } from "@/lib/data/field-mappings-types";
import { techStackChoices } from "@/lib/data/profile-field-options-types";

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
  // Live / Onboarding / At Risk / Churned pill from HubSpot's
  // company_status. Ships default-visible alongside Engagement + CSM
  // so the same "state of the account" cluster reads left-to-right;
  // the column picker can hide it. The Status filter dropdown above
  // the table already existed — surfacing the pill inline saves the
  // reader an expand click to see whether a row is Live vs still
  // Onboarding when scanning.
  {
    key: "property_company_status",
    label: "Status",
    width: "w-[8%]",
    showAt: "md",
  },
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

/**
 * Column-visibility metadata, derived from COLUMNS. Company is
 * required (it's the row anchor — without it the Account name
 * disappears). Everything else is toggleable via the picker. Keys
 * mirror COLUMNS[].key 1:1 so columns.isVisible(col.key) just works.
 */
const VISIBILITY_COLUMNS: VisibilityColumnDef[] = COLUMNS.map((c) => ({
  key: c.key,
  label: c.label,
  required: c.key === "company_name",
}));

export function CustomerTable({
  initialCustomers,
  csms,
  priorEspOptions = [],
  techStackOptions = [],
}: {
  initialCustomers: CustomerWithMetrics[];
  csms: string[];
  /** Shared admin-managed choices for the Prior ESP filter. */
  priorEspOptions?: string[];
  /** Shared admin-managed choices for the Tech Stack filter. */
  techStackOptions?: string[];
}) {
  const viewerEmail = useViewerEmail();
  // Signed-in CSM's custom merge tags. Threaded into buildBulkDrafts
  // so shared outreach templates that reference the sender's
  // {{scheduling_text}} / signature / etc. resolve to this CSM's copy
  // for every draft. `null` while loading — falls through to the
  // no-custom-tags path (tokens render as-is), which matches how the
  // preview would render before /api/settings/merge-tags loaded anyway.
  const customTags = useCustomMergeTags();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Resync-from-HubSpot state. Button POSTs to
  // /api/customers/refresh-hubspot scoped to the current CSM filter;
  // writes a per-workspace overlay that loadCustomers() merges on
  // top of the encrypted snapshot. router.refresh() after success
  // pulls the new values into every server-rendered surface.
  const [resyncBusy, setResyncBusy] = useState(false);
  const [resyncMessage, setResyncMessage] = useState<string | null>(null);
  async function resyncFromHubspot() {
    setResyncBusy(true);
    setResyncMessage(null);
    try {
      const csmScope = searchParams.get("csm");
      const url = new URL(
        "/api/customers/refresh-hubspot",
        window.location.origin
      );
      if (csmScope) url.searchParams.set("csm", csmScope);
      const r = await fetch(url.toString(), { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        processed?: number;
        updated?: number;
        no_hubspot_company_id?: number;
        errors?: Array<{ workspace_id: string; reason: string }>;
        truncated?: boolean;
        error?: string;
      };
      if (!r.ok || j.ok === false) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const parts: string[] = [];
      parts.push(`${j.updated ?? 0} updated`);
      if ((j.no_hubspot_company_id ?? 0) > 0)
        parts.push(`${j.no_hubspot_company_id} no HubSpot link`);
      if ((j.errors?.length ?? 0) > 0) {
        parts.push(`${j.errors!.length} HubSpot misses`);
      }
      if (j.truncated)
        parts.push(`(truncated — re-run for the rest)`);
      setResyncMessage(
        `Resynced ${j.processed ?? 0} customer${j.processed === 1 ? "" : "s"} from HubSpot — ${parts.join(", ")}.`
      );
      // Re-render so the merged overlay surfaces in every cell.
      router.refresh();
    } catch (e) {
      setResyncMessage(
        `Resync failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setResyncBusy(false);
      setTimeout(() => setResyncMessage(null), 12_000);
    }
  }

  // Per-table column visibility (localStorage-backed). Company is
  // required so the column picker never offers to hide it. Everything
  // else is toggleable via the "Columns ▾" dropdown above the table.
  const columns = useColumnVisibility("customer-book", VISIBILITY_COLUMNS);

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
  const [sortKey, setSortKey] = useState<SortKey>("arr");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useUrlSearch("q");
  // Lifecycle filter: q10600 already restricts to Live + Onboarding,
  // so those are the only two values that show up in the book. The
  // empty/"All" option leaves both showing. Synced to the URL so the
  // viewer can deep-link a status-scoped view.
  const [statusFilter, setStatusFilter] = useUrlSearch("status");
  // Prior ESP + Tech Stack multi-selects. Each is URL-synced as a
  // comma-joined param (?prior_esp= / ?tech=), hydrated into a Set here
  // (useUrlSearch only holds a single string, so the join/split lives
  // in these hooks).
  const [priorEspRaw, setPriorEspRaw] = useUrlSearch("prior_esp");
  const priorEspSelected = useMemo(
    () =>
      new Set(
        priorEspRaw
          ? priorEspRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : []
      ),
    [priorEspRaw]
  );
  const togglePriorEsp = useCallback(
    (value: string) => {
      const next = new Set(priorEspSelected);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      setPriorEspRaw(Array.from(next).join(","));
    },
    [priorEspSelected, setPriorEspRaw]
  );
  const [techRaw, setTechRaw] = useUrlSearch("tech");
  const techSelected = useMemo(
    () =>
      new Set(
        techRaw
          ? techRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : []
      ),
    [techRaw]
  );
  const toggleTech = useCallback(
    (value: string) => {
      const next = new Set(techSelected);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      setTechRaw(Array.from(next).join(","));
    },
    [techSelected, setTechRaw]
  );
  const [featureMatcher, setFeatureMatcher] =
    useState<WorkspaceFeatureMatcher | null>(null);
  const [outreachFor, setOutreachFor] = useState<Customer | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Deep-link support: /csm?workspace_id=X pre-expands that row and
  // scrolls it into view. Used by the personal-todos panel's "Open
  // profile" link so a CSM can jump from a fired renewal-milestone
  // todo straight to the customer's expanded profile. Runs once per
  // param change; guarded on a ref so re-mounts don't re-scroll.
  const deepLinkedRef = useRef<string | null>(null);
  useEffect(() => {
    const target = searchParams.get("workspace_id");
    if (!target || deepLinkedRef.current === target) return;
    deepLinkedRef.current = target;
    setExpanded((prev) => {
      if (prev.has(target)) return prev;
      const next = new Set(prev);
      next.add(target);
      return next;
    });
    // Wait one frame for the row to render, then scroll to it. Doing
    // this synchronously catches the pre-render height. A short
    // timeout is fine — a missing row also fails silently, which is
    // the right behavior when the deep-link target is filtered out.
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `tr[data-workspace-id="${CSS.escape(target)}"]`
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [searchParams]);
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
    (matcher: WorkspaceFeatureMatcher | null) => {
      setFeatureMatcher(() => matcher);
    },
    []
  );

  const featureWorkspaceIds = useMemo(
    () =>
      initialCustomers
        .map((c) => c.workspace_id)
        .filter((id): id is string => Boolean(id)),
    [initialCustomers]
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
    if (featureMatcher) {
      list = list.filter((c) => featureMatcher(c.workspace_id));
    }
    if (statusFilter) {
      const target = statusFilter.toLowerCase();
      list = list.filter(
        (c) => (c.property_company_status ?? "").toLowerCase() === target
      );
    }
    if (priorEspSelected.size > 0) {
      // OR within the facet: a row matches if it migrated from ANY of
      // the selected ESPs.
      list = list.filter((c) => {
        const esps = c.prior_esp ?? [];
        for (const t of priorEspSelected) {
          if (esps.some((s) => s.toLowerCase() === t.toLowerCase())) {
            return true;
          }
        }
        return false;
      });
    }
    if (techSelected.size > 0) {
      // OR within the facet: a row matches if it uses ANY of the
      // selected tools.
      list = list.filter((c) => {
        const stack = c.tech_stack ?? [];
        for (const t of techSelected) {
          if (stack.some((s) => s.toLowerCase() === t.toLowerCase())) {
            return true;
          }
        }
        return false;
      });
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
    featureMatcher,
    statusFilter,
    priorEspSelected,
    techSelected,
    sortKey,
    sortDir,
    ws2pubs,
    gmailDateFor,
  ]);

  // Counts shown next to each option in the status dropdown so the
  // viewer sees how many rows each filter would yield. Derived from
  // the full book (ignoring the active status filter), so the counts
  // stay stable as the user toggles.
  //
  // Discovered dynamically from the book rather than hard-coded —
  // HubSpot has more than Live/Onboarding (At Risk, Churned, and any
  // custom values a team adds) and we want each to be filterable
  // without a code change. The option list is sorted by count desc
  // so the most common statuses land at the top of the dropdown.
  const statusOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of initialCustomers) {
      const raw = c.property_company_status?.trim();
      if (!raw) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
    const options = Array.from(counts.entries()).map(([value, count]) => ({
      value,
      label: value,
      count,
    }));
    options.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
    const total = options.reduce((s, o) => s + o.count, 0);
    return { options, total };
  }, [initialCustomers]);

  // Per-option counts for the Prior ESP dropdown + Tech Stack chips,
  // derived from the full book (ignoring the active profile filters) so
  // they stay stable as the user toggles. Counted per OPTION and
  // case-insensitively — matching how the filters compare — so the
  // count stays correct even if a stored value differs in casing from
  // the option label (e.g. after an admin re-cases an option). Keying
  // by the option value also gives every option an explicit count
  // (0 for unused ones), so ChipMultiSelect can dim/disable chips that
  // would yield zero rows.
  const priorEspCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const o of priorEspOptions) {
      const target = o.toLowerCase();
      m[o] = initialCustomers.filter((c) =>
        (c.prior_esp ?? []).some((s) => s.toLowerCase() === target)
      ).length;
    }
    return m;
  }, [initialCustomers, priorEspOptions]);
  // The Tech Stack dropdown offers its own options PLUS every Prior ESP
  // name — matching the editor in the detail panel, so a value a CSM
  // can tag is always a value they can filter on. Prior ESP and Tech
  // Stack remain separate fields reading separate data; only this
  // choice list is widened. Zero-count entries are fine here: both
  // profile filters already pass disableZeroCounts={false}.
  const techFilterOptions = useMemo(
    () =>
      techStackChoices({
        priorEsp: priorEspOptions,
        techStack: techStackOptions,
      }),
    [priorEspOptions, techStackOptions]
  );
  const techCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const o of techFilterOptions) {
      const target = o.toLowerCase();
      m[o] = initialCustomers.filter((c) =>
        (c.tech_stack ?? []).some((s) => s.toLowerCase() === target)
      ).length;
    }
    return m;
  }, [initialCustomers, techFilterOptions]);

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
    if (featureMatcher) return "feature-not-using";
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
      // Profile fields — useful for reporting even though they're only
      // *editable* on the customer detail panel. Semicolon-joined: the
      // values themselves are comma-free (the API strips commas so the
      // filters can round-trip through a comma-joined URL param).
      { header: "Prior ESP", pick: (c) => (c.prior_esp ?? []).join("; ") },
      { header: "Tech stack", pick: (c) => (c.tech_stack ?? []).join("; ") },
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
      customTags: customTags ?? undefined,
      auditLabel: `${tpl.label} email sent`,
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
            {/* Workspace name as line 2 only when it differs from the
             *  company name (often it's identical and would just be
             *  duplicated noise). Owner email follows as a small
             *  mailto-link so a CSM can copy/open from the table
             *  without expanding the row. */}
            {c.workspace_name &&
            c.workspace_name !== (c.company_name ?? c.workspace_name) ? (
              <div className="text-xs text-muted break-words">
                {c.workspace_name}
              </div>
            ) : null}
            {c.owner_email ? (
              <a
                href={`mailto:${c.owner_email}`}
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-subtle hover:text-accent break-words block"
                title={c.owner_email}
              >
                {c.owner_email}
              </a>
            ) : null}
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
        // Compact inline editor — CSMs can change Engagement (Touch
        // level) without expanding the detail panel. Push-to-HubSpot
        // is wired via the standard field-mappings flow the detail
        // panel already uses; the read-only chip stays visually
        // identical, just clickable now.
        return (
          <MappedFieldEditor
            compact
            fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
              (f) => f.id === "company_engagement"
            )!}
            currentValue={c.company_engagement}
            workspaceId={c.workspace_id}
            renderReadOnly={(v) => <StatusBadge value={v ?? null} />}
          />
        );
      case "property_company_status":
        return <StatusBadge value={c.property_company_status ?? null} />;
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
        // Compact inline editor — CSMs can change Risk without
        // expanding the detail panel. The chip render is unchanged
        // (RiskLevelChip is passed through as renderReadOnly), so
        // sort behavior, colour coding, and the risk-detail tooltip
        // all keep working exactly as before.
        return (
          <MappedFieldEditor
            compact
            fieldDef={MAPPABLE_DASHBOARD_FIELDS.find(
              (f) => f.id === "property_risk_level"
            )!}
            currentValue={c.property_risk_level}
            workspaceId={c.workspace_id}
            renderReadOnly={(v) => (
              <RiskLevelChip
                level={v ?? null}
                detail={c.property_risk_level_detail}
              />
            )}
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
        const cadenceBucket = intervalBucket(c);
        const cadenceLabel = cadenceRowLabel(c);
        const cadenceClass = cadenceBucket
          ? cadenceBadgeClass(cadenceBucket)
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
          emptyCount={statusOptions.total}
          options={statusOptions.options}
        />
        {priorEspOptions.length > 0 ? (
          <MultiSelectFilter
            label="Prior ESP"
            emptyLabel="All"
            className="w-40 justify-between"
            disableZeroCounts={false}
            options={priorEspOptions.map((o) => ({
              value: o,
              label: o,
              count: priorEspCounts[o] ?? 0,
            }))}
            selected={priorEspSelected}
            onToggle={togglePriorEsp}
            onClear={() => setPriorEspRaw("")}
          />
        ) : null}
        {techFilterOptions.length > 0 ? (
          <MultiSelectFilter
            label="Tech stack"
            emptyLabel="All"
            className="w-40 justify-between"
            disableZeroCounts={false}
            options={techFilterOptions.map((o) => ({
              value: o,
              label: o,
              count: techCounts[o] ?? 0,
            }))}
            selected={techSelected}
            onToggle={toggleTech}
            onClear={() => setTechRaw("")}
          />
        ) : null}
      </FilterBar>

      <div className="space-y-3 mb-4">
        <FeatureUtilizationFilter
          workspaceIds={featureWorkspaceIds}
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
            {featureMatcher ? "feature-not-using" : "general-checkin"}
          </code>
        </span>
        <div className="flex-1" />
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
      {resyncMessage ? (
        <div className="text-xs text-muted bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-md px-3 py-2 mb-3">
          {resyncMessage}
        </div>
      ) : null}
      {/* "Columns ▾" picker + the "Resync from HubSpot" pill —
       *  right-aligned above the table. Resync hits HubSpot live
       *  for every customer in the current CSM scope + writes a
       *  per-workspace overlay loadCustomers() merges over the
       *  snapshot. Useful when a CSM has just edited labels /
       *  contacts / the Customer Folder property in HubSpot and
       *  wants the change visible without waiting for the next
       *  daily sync. */}
      <div className="flex justify-end items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => void resyncFromHubspot()}
          disabled={resyncBusy}
          className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-surface-2 disabled:opacity-50"
          title="Pull every customer's contacts + Customer Folder URL fresh from HubSpot. ~10s for a 150-customer book."
        >
          {resyncBusy ? "Resyncing…" : "↻ Resync from HubSpot"}
        </button>
        <ColumnPicker state={columns} align="right" />
      </div>
      <div className="rounded-xl border border-border bg-surface shadow-card">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-8" />
            <col className="w-8" />
            {COLUMNS.filter((c) => columns.isVisible(c.key)).map((c) => (
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
              <th className="px-2 py-2.5 w-8"></th>
              <th className="px-2 py-2.5 w-8"></th>
              {COLUMNS.filter((col) => columns.isVisible(col.key)).map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  // overflow-hidden + whitespace-nowrap: with
                  // table-fixed, a too-long header would otherwise
                  // bleed into the next cell (e.g. "EngagementCSM"
                  // smashed together). Clip instead.
                  className={`px-2 py-2.5 font-medium text-muted cursor-pointer hover:bg-surface-2 select-none overflow-hidden text-ellipsis ${
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
              <th className="px-2 py-2.5"></th>
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
                    // data-workspace-id hook lets the ?workspace_id=…
                    // deep-link effect scroll this row into view.
                    data-workspace-id={c.workspace_id ?? undefined}
                    className={`border-b border-border cursor-pointer transition-colors align-top ${
                      isOpen ? "bg-blue-50 dark:bg-blue-500/40" : "hover:bg-blue-50 dark:bg-blue-500/30"
                    }`}
                  >
                    <td
                      className="px-2 py-2"
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
                    <td className="px-2 py-2 text-subtle select-none">
                      <span
                        className={`inline-block transition-transform ${
                          isOpen ? "rotate-90" : ""
                        }`}
                      >
                        ▸
                      </span>
                    </td>
                    {COLUMNS.filter((col) => columns.isVisible(col.key)).map((col) => (
                      <td
                        key={col.key}
                        // overflow-hidden so a too-wide chip (e.g.
                        // "Medium Touch") doesn't bleed into the
                        // adjacent column visually. Individual cell
                        // renderers can still opt-in to multi-line
                        // layouts (Company, Next charge) — their
                        // outer wrappers govern wrapping.
                        className={`px-2 py-2 overflow-hidden ${
                          col.align === "right" ? "text-right" : ""
                        } ${SHOW_CLASS[col.showAt ?? "always"]}`}
                      >
                        {renderCell(c, col.key)}
                      </td>
                    ))}
                    <td className="px-2 py-2 text-right">
                      <RowActions customer={c} onDraft={setOutreachFor} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-blue-50 dark:bg-blue-500/20 border-b border-border">
                      <td
                        colSpan={
                          COLUMNS.filter((col) => columns.isVisible(col.key))
                            .length + 3
                        }
                        className="px-6 py-4"
                      >
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
