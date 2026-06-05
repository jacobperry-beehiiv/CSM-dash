"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { PastDueRow } from "@/lib/engines/am-cohorts";
import { fmtCurrency, fmtDate } from "../format";
import {
  findSlackChannel,
  PAST_DUE_CHANNEL_ID,
  type SettingsShape,
} from "@/lib/data/settings-types";
import { BucketSection } from "./bucket-section";
import { FilterBar, SearchInput, SelectFilter } from "../filters";
import { CsmSelector } from "../csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import {
  SlackBulkCompose,
  type BulkSlackMessage,
} from "./slack-bulk-compose";
import { BulkEmailLauncher } from "./bulk-email-launcher";
import { LowTierBulkSend } from "./low-tier-bulk-send";
import { NotesChip } from "./notes-chip";
import { ReviewStateCell } from "./review-state-cell";
import { SendDigestButton } from "./send-digest-button";
import { CustomerDetailPanel } from "../customer-detail-panel";
import {
  needsReview,
  type ReviewState,
  type ReviewStatesMap,
} from "@/lib/data/review-states-types";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import { useStripeCustomerIndex } from "@/lib/hooks/use-stripe-customer-index";
import { synthesizeCustomer } from "@/lib/data/synthesize-customer";
import { stripeCustomerUrl } from "@/lib/links";
import type { Customer } from "@/lib/types";
import type {
  PastDueOutreachMap,
  PastDueOutreachStatus,
} from "@/lib/data/past-due-outreach";
// Import from the types-only file — past-due-history.ts pulls in the
// Postgres/Metabase reconciler which can't be shipped to the browser.
import type { PastDueHistoryMap } from "@/lib/data/past-due-history-types";
import { monthsObserved } from "@/lib/data/past-due-history-types";

interface Props {
  /** Already CSM-filtered server-side (per `?csm=…`). The client still
   *  applies search + plan-tier filters on top of this list. */
  rows: PastDueRow[];
  /** All CSMs in the book so the dropdown can render its options. */
  csms: string[];
  /** Total count from q24620 BEFORE the server applied the CSM filter,
   *  used for the "Showing X of Y" diagnostic line. */
  totalSourceRows: number;
}

const BUCKET_STEP_USD = 50_000;

interface BucketRange {
  label: string;
  min: number;
  max: number;
  toneClass: string;
}

function makeBuckets(maxArr: number): BucketRange[] {
  // Buckets are half-open [lo, hi). Round the ceiling STRICTLY above maxArr
  // so a row with arr_dollars equal to a $50K multiple still lands in the
  // top bucket (otherwise the headline-vs-list count drifts).
  //
  //   maxArr = 99,999  →  ceiling = 100,000 (top bucket [50K, 100K) catches it)
  //   maxArr = 100,000 →  ceiling = 150,000 (top bucket [100K, 150K) catches it)
  //   maxArr = 0       →  ceiling = 50,000  (one bucket [0, 50K))
  const ceiling = Math.max(
    BUCKET_STEP_USD,
    Math.floor(Math.max(0, maxArr) / BUCKET_STEP_USD) * BUCKET_STEP_USD +
      BUCKET_STEP_USD
  );
  const ranges: BucketRange[] = [];
  for (let lo = ceiling - BUCKET_STEP_USD; lo >= 0; lo -= BUCKET_STEP_USD) {
    const hi = lo + BUCKET_STEP_USD;
    const isTop = lo >= 100_000;
    ranges.push({
      label: `${fmtCurrency(lo)} – ${fmtCurrency(hi)}`,
      min: lo,
      max: hi,
      toneClass: isTop
        ? "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900"
        : lo >= 25_000
          ? "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900"
          : "bg-canvas border-border text-fg",
    });
  }
  return ranges;
}

function isEnterprisePlan(p: PastDueRow): boolean {
  // Beehiiv tier ladder: Launch → Scale → Max → Max Plus → Enterprise.
  // "Max" is a paid plan but NOT Enterprise — including it would inflate
  // the headline count and mis-badge ~38 rows in the past-due feed.
  return /enterprise|custom/i.test(p.price_name ?? "");
}

// ─── Phase 1 tier classification (per AM Hackathon brief) ────────────
//
//   Enterprise:   has a CSM assigned (canonical Enterprise signal at
//                 beehiiv; self-serve doesn't get a CSM). Falls through
//                 to plan-name regex when the row is unassigned but the
//                 price_name explicitly says "enterprise" / "custom".
//   Above $3.5K:  no CSM AND ARR >= $3,500 AND not an Ent plan.
//   Below $3.5K:  no CSM AND ARR <  $3,500 AND not an Ent plan.
//
// Initial implementation tied Enterprise to the plan-name regex AND
// CSM presence — which silently misclassified rows where q24620
// didn't surface a price_name (rows showed `Plan = —` but had a CSM
// and high ARR). CSM presence is the stronger signal.
const ABOVE_THRESHOLD_USD = 3_500;

type PastDueTier =
  | "enterprise"
  | "above"
  | "below"
  | "followup";

function classifyPastDue(r: PastDueRow): "enterprise" | "above" | "below" {
  const hasCsm = Boolean(r.customer_success_manager);
  if (hasCsm) return "enterprise";
  // Edge case — Enterprise account between CSM assignments. Fall back
  // to the plan-name regex so we still bucket them correctly.
  if (isEnterprisePlan(r)) return "enterprise";
  if (r.arr_dollars >= ABOVE_THRESHOLD_USD) return "above";
  return "below";
}

/** Past Due is now organized into four sub-tabs per the AM Hackathon
 *  brief: three by tier + a Follow-Up tracker. Tab id is URL-synced
 *  so deep-links land on the right view. */
type PastDueSubtab = "enterprise" | "above" | "below" | "followup";

const SUBTAB_LABELS: Record<PastDueSubtab, string> = {
  enterprise: "Enterprise",
  above: "Above $3.5K",
  below: "Below $3.5K",
  followup: "Follow-Up",
};

export function PastDuePanel({ rows, csms, totalSourceRows }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [outreachMap, setOutreachMap] = useState<PastDueOutreachMap>({});
  // Past-due episode history keyed by customer_id. Populated by the
  // daily reconciliation cron + on-demand sweep below. Drives the
  // "N mo past-due" badge on each row + the expandable episode log.
  const [historyMap, setHistoryMap] = useState<PastDueHistoryMap>({});
  // Which customer_ids currently have their history row expanded.
  const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyReport, setHistoryReport] = useState<string | null>(null);
  // Surfaces success / failure of the manual "Mark touched" + "Mark
  // follow-up sent" buttons. Without this the button silently no-ops
  // when the fetch fails — the user sees no feedback and assumes the
  // button is broken.
  const [touchReport, setTouchReport] = useState<string | null>(null);
  const [touchBusy, setTouchBusy] = useState(false);
  // Which rowKeys currently have their full CustomerDetailPanel
  // expanded. Separate from `historyOpen` so the existing
  // click-email-for-episode-history affordance keeps working
  // independently of the new chevron-for-full-detail one.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-workflow review map (Phase A of the digest workflow). The
  // panel uses this to render the Review dropdown per row + scope
  // the visible rows when ?needs_review=1 is in the URL (the
  // digest-link target).
  const [reviewStates, setReviewStates] = useState<ReviewStatesMap>({});
  const [needsReviewFilter, setNeedsReviewFilter] = useUrlSearch(
    "needs_review"
  );
  useEffect(() => {
    fetch("/api/review-states")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setReviewStates(j as ReviewStatesMap))
      .catch(() => {});
  }, []);
  const onReviewChange = (
    workspaceId: string,
    next: ReviewState | null
  ) => {
    setReviewStates((prev) => {
      const map = { ...prev };
      const current = { ...(map[workspaceId] ?? {}) };
      if (next === null) {
        delete current.past_due;
      } else {
        current.past_due = {
          state: next,
          set_at: new Date().toISOString(),
          set_by: null,
        };
      }
      if (Object.keys(current).length === 0) {
        delete map[workspaceId];
      } else {
        map[workspaceId] = current;
      }
      return map;
    });
  };
  function toggleExpanded(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // Filter state. CSM filtering is applied server-side (see /am/page.tsx
  // PastDueTab), so `rows` arrives already narrowed when ?csm= is in
  // the URL. Sub-tab is URL-synced for deep-link friendliness.
  const [search, setSearch] = useUrlSearch("q");
  const [subtabRaw, setSubtab] = useUrlSearch("pdtab");
  // Outreach-state filter — "has" surfaces only rows the AM has
  // already touched, "none" surfaces only unactioned ones.
  // URL-synced via ?outreach= so deep-links to "everyone I haven't
  // touched yet" work as a daily-handoff link.
  const [outreachFilter, setOutreachFilter] = useUrlSearch("outreach");
  const subtab: PastDueSubtab =
    subtabRaw === "above" ||
    subtabRaw === "below" ||
    subtabRaw === "followup"
      ? subtabRaw
      : "enterprise";

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setSettings(j as SettingsShape))
      .catch(() => {});
  }, []);

  // Outreach lifecycle map (customer_id → status). Populated by the
  // bulk-send flows; surfaces the Follow-Up sub-tab + drives the
  // "touched" badge on rows in other tabs.
  const reloadOutreach = () => {
    fetch("/api/past-due/outreach")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setOutreachMap((j as PastDueOutreachMap) ?? {}))
      .catch(() => {});
  };
  const reloadHistory = () => {
    fetch("/api/past-due/history")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setHistoryMap((j as PastDueHistoryMap) ?? {}))
      .catch(() => {});
  };
  useEffect(() => {
    reloadOutreach();
    reloadHistory();
  }, []);

  // Customer book — fetched once so the bulk-email launcher can hand
  // full Customer records (with HubSpot contacts) to the BulkDraftsModal.
  // Without this we'd only have PastDueRow data, which lacks the
  // merge-tag fields the template renderer expects.
  const [customerBook, setCustomerBook] = useState<Customer[]>([]);
  useEffect(() => {
    fetch("/api/customers")
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => setCustomerBook((list as Customer[]) ?? []))
      .catch(() => {});
  }, []);

  /** Stripe-customer-id index of the book for O(1) selected-row → Customer
   *  lookups. q24620's `customer_id` is the Stripe cus_… id; q10600
   *  surfaces the same id as Customer.stripe_customer_id. */
  const customerByStripeId = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customerBook) {
      if (c.stripe_customer_id) m.set(c.stripe_customer_id, c);
    }
    return m;
  }, [customerBook]);

  // Publication-index drives the workspace/publication-ID search
  // affordance. Lazily loaded once per tab session — soft-fails to
  // empty so search keeps working if the endpoint hiccups (just
  // without pub-ID lookup).
  const { ws2pubs } = usePublicationsIndex();
  // Stripe → workspace fallback for rows whose stripe_customer_id
  // isn't in the customer book (q10600 only carries paying-CSM-
  // assigned accounts; q24620 surfaces everyone past-due). Lets us
  // still synthesize a Customer + drive the notes section by
  // workspace_id.
  const { stripe2ws } = useStripeCustomerIndex();

  /** Apply search to the CSM-filtered rows, then dedupe per Stripe
   *  customer_id (q24620 can return multiple rows for the same
   *  customer — one per failed charge attempt or per past-due
   *  subscription). Keeps the most-recent charge attempt; ties go to
   *  the higher-ARR row.
   *
   *  Rows without a customer_id are kept as-is and keyed on subscription_id
   *  so they don't collapse into each other. */
  const searched = useMemo(() => {
    const haystackMatch = (r: PastDueRow): boolean => {
      if (!search) return true;
      const q = search.toLowerCase();
      // Resolve to Customer so the search can match against the
      // workspace ID + every publication ID owned by that workspace.
      // PastDueRow itself only carries billing-side fields.
      const resolved = r.customer_id
        ? customerByStripeId.get(r.customer_id)
        : null;
      const workspaceId = resolved?.workspace_id ?? null;
      const pubs = workspaceId ? ws2pubs[workspaceId] ?? [] : [];
      // CSMs are stored snake_cased (e.g. "olivia_chen"). Include
      // both the raw form and a humanized "olivia chen" so either
      // typing pattern matches.
      const csm = r.customer_success_manager ?? null;
      const csmHuman = csm?.replace(/_/g, " ") ?? null;
      const haystack = [
        r.email,
        r.customer_id,
        r.price_name,
        csm,
        csmHuman,
        workspaceId,
        resolved?.workspace_name,
        resolved?.company_name,
        ...pubs,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    };

    const byKey = new Map<string, PastDueRow>();
    for (const r of rows) {
      if (!haystackMatch(r)) continue;
      const key = r.customer_id ?? `sub:${r.subscription_id ?? ""}`;
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, r);
        continue;
      }
      // Same customer — keep the row with the latest charge attempt.
      // ISO timestamps compare lexicographically, so string > is fine.
      const eDate = existing.charge_attempted_at ?? "";
      const rDate = r.charge_attempted_at ?? "";
      if (rDate > eDate) {
        byKey.set(key, r);
      } else if (rDate === eDate && r.arr_dollars > existing.arr_dollars) {
        byKey.set(key, r);
      }
    }
    return Array.from(byKey.values());
  }, [rows, search, customerByStripeId, ws2pubs]);

  /** Map customer_id → tier classification. Computed once per searched
   *  list so tab counts and the rendered tier match exactly. */
  const tierByCustomerId = useMemo(() => {
    const m = new Map<string, ReturnType<typeof classifyPastDue>>();
    for (const r of searched) {
      if (r.customer_id) m.set(r.customer_id, classifyPastDue(r));
    }
    return m;
  }, [searched]);

  const tierCounts = useMemo(() => {
    const c = { enterprise: 0, above: 0, below: 0 };
    for (const r of searched) {
      c[classifyPastDue(r)]++;
    }
    return c;
  }, [searched]);

  // Follow-Up sub-tab: rows whose customer_id is in `outreachMap` with
  // status "touched" (waiting for follow-up) — anywhere across all
  // tiers. Other statuses (follow_up_sent / paid / lost) are still
  // listed so AM has a single place to review where each account
  // sits in the lifecycle.
  const followUpRows = useMemo(() => {
    return searched.filter((r) => {
      if (!r.customer_id) return false;
      const entry = outreachMap[r.customer_id];
      return Boolean(entry);
    });
  }, [searched, outreachMap]);

  /** Rows for the active sub-tab. Follow-Up uses the lifecycle map;
   *  others use tier classification. */
  const filteredRows = useMemo(() => {
    const base =
      subtab === "followup"
        ? followUpRows
        : searched.filter((r) => {
            const tier = r.customer_id
              ? tierByCustomerId.get(r.customer_id) ?? classifyPastDue(r)
              : classifyPastDue(r);
            return tier === subtab;
          });
    let next = base;
    if (outreachFilter === "has" || outreachFilter === "none") {
      next = next.filter((r) => {
        const touched = Boolean(
          r.customer_id ? outreachMap[r.customer_id] : null
        );
        return outreachFilter === "has" ? touched : !touched;
      });
    }
    // ?needs_review=1 → only rows where past-due review-state is
    // reach_out or unset. Used by the digest deep-link so a CSM
    // lands on exactly what's left to triage for this workflow.
    if (needsReviewFilter === "1") {
      next = next.filter((r) => {
        const ws = r.customer_id
          ? customerByStripeId.get(r.customer_id)?.workspace_id ?? null
          : null;
        return ws ? needsReview(reviewStates[ws], "past_due") : true;
      });
    }
    return next;
  }, [
    subtab,
    searched,
    tierByCustomerId,
    followUpRows,
    outreachFilter,
    outreachMap,
    needsReviewFilter,
    reviewStates,
    customerByStripeId,
  ]);

  const maxArr = useMemo(
    () => filteredRows.reduce((m, r) => Math.max(m, r.arr_dollars), 0),
    [filteredRows]
  );
  const bucketRanges = useMemo(() => makeBuckets(maxArr), [maxArr]);

  const grouped = useMemo(() => {
    return bucketRanges
      .map((b) => ({
        bucket: b,
        list: filteredRows
          .filter((r) => r.arr_dollars >= b.min && r.arr_dollars < b.max)
          .sort((a, b2) => b2.arr_dollars - a.arr_dollars),
      }))
      .filter((g) => g.list.length > 0);
  }, [filteredRows, bucketRanges]);

  // Compute headline stats from the SAME rows the buckets actually render so
  // the "Past-due Enterprise" count and the visible ENT rows can never drift.
  const visibleRows = useMemo(
    () => grouped.flatMap((g) => g.list),
    [grouped]
  );
  // Diff is against the filtered set so the warning only fires for rows
  // that ARE supposed to be in view but couldn't be bucketed.
  const droppedCount = filteredRows.length - visibleRows.length;

  const enterpriseRows = visibleRows.filter(isEnterprisePlan);
  const enterpriseArrTotal = enterpriseRows.reduce(
    (s, r) => s + r.arr_dollars,
    0
  );
  const totalArr = visibleRows.reduce((s, r) => s + r.arr_dollars, 0);

  function rowKey(r: PastDueRow, i: number): string {
    return r.subscription_id ?? r.customer_id ?? `${i}`;
  }

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function selectAllIn(list: PastDueRow[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      list.forEach((r, i) => next.add(rowKey(r, i)));
      return next;
    });
  }

  // `rows.length` here is the post-server-CSM-filter count; the prop
  // `totalSourceRows` carries the pre-filter total so we can show
  // "Showing 1 of 229 past-due accounts" honestly.
  const filteredCount = filteredRows.length;
  const filtersActive =
    Boolean(search) || rows.length !== totalSourceRows;

  // Whenever the sub-tab changes, drop any cross-tab selections so the
  // bulk-actions toolbar can't accidentally email accounts from a
  // tier that's no longer visible.
  useEffect(() => {
    setSelected(new Set());
  }, [subtab]);

  return (
    <>
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search email, customer id, plan, CSM, workspace / publication ID…"
        />
        {/* Past Due is a team-wide triage view, so the dropdown
         *  defaults to "All CSMs" rather than the viewer's own handle.
         *  Matches the server-side resolution in /am/page.tsx's
         *  PastDueTab branch. */}
        <CsmSelector csms={csms} defaultsToAll />
        <SelectFilter
          label="Outreach"
          value={outreachFilter}
          onChange={setOutreachFilter}
          emptyLabel="Any"
          options={[
            { value: "none", label: "No outreach yet" },
            { value: "has", label: "Has outreach" },
          ]}
        />
      </FilterBar>

      {/* Sub-tab nav — Enterprise / Above $3.5K / Below $3.5K / Follow-Up.
       *  Counts come from the tier classifier so admins can see at a
       *  glance where the work is concentrated. */}
      <div className="flex flex-wrap items-center gap-1 mb-4 border-b border-border">
        {(["enterprise", "above", "below", "followup"] as const).map((t) => {
          const count =
            t === "followup"
              ? followUpRows.length
              : t === "enterprise"
                ? tierCounts.enterprise
                : t === "above"
                  ? tierCounts.above
                  : tierCounts.below;
          const active = subtab === t;
          return (
            <button
              key={t}
              onClick={() => setSubtab(t)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                active
                  ? "border-accent text-fg font-semibold"
                  : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {SUBTAB_LABELS[t]}{" "}
              <span className="text-xs text-subtle">({count})</span>
            </button>
          );
        })}
      </div>

      {filtersActive ? (
        <p className="text-xs text-muted mb-3">
          Showing <strong className="text-fg">{filteredCount}</strong> of{" "}
          {totalSourceRows} past-due accounts in this tier
        </p>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="In this tier" value={String(visibleRows.length)} />
        <Stat
          label="Enterprise in view"
          value={String(enterpriseRows.length)}
          accent={enterpriseRows.length > 0 && subtab === "enterprise"}
        />
        <Stat
          label="Enterprise ARR"
          value={fmtCurrency(enterpriseArrTotal)}
          accent={enterpriseArrTotal > 0 && subtab === "enterprise"}
        />
        <Stat label="Tier ARR past due" value={fmtCurrency(totalArr)} />
      </div>

      {droppedCount > 0 ? (
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-3 text-sm text-amber-900 mb-4">
          {droppedCount} row{droppedCount === 1 ? "" : "s"} from q24620 fell
          outside the ARR buckets (likely due to negative or non-numeric{" "}
          <code className="font-mono px-1 bg-amber-100 rounded">arr_cents</code>
          ) and aren&rsquo;t shown below.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-muted">
          <strong>{selected.size}</strong> selected
        </span>
        <button
          onClick={() =>
            setSelected(new Set(visibleRows.map((r, i) => rowKey(r, i))))
          }
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
          title="Select every account currently visible (after filters)"
        >
          Select all
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        >
          Clear
        </button>
        <div className="flex-1" />
        {(() => {
          // Resolve each selected past-due row to a Customer record (by
          // stripe_customer_id) so the BulkDraftsModal has the merge-tag
          // fields it expects. Rows without a matching Customer (e.g. a
          // cancelled workspace removed from the book) are dropped.
          //
          // Iterate the DEDUPED list (`searched`) rather than the raw
          // `rows` array — q24620 can have multiple charge-attempt rows
          // per customer, and using the raw list here would resolve the
          // same customer multiple times and create duplicate drafts.
          const selectedRows = searched.filter((r, i) =>
            selected.has(rowKey(r, i))
          );
          const selectedCustomers = selectedRows
            .map((r) =>
              r.customer_id ? customerByStripeId.get(r.customer_id) : null
            )
            .filter((c): c is Customer => Boolean(c));
          const selectedCustomerIds = selectedCustomers
            .map((c) => c.stripe_customer_id ?? "")
            .filter(Boolean);
          // For "Mark touched" we pull customer_ids straight from the
          // PastDueRow — q24620's `customer_id` IS the Stripe ID, so
          // there's no need to round-trip through the customer book.
          // This previously caused a silent no-op when:
          //   • the customer book hadn't loaded yet (cold tab open)
          //   • a past-due row referenced a customer that wasn't in
          //     the current q10600 (cancelled workspace, etc.)
          // Either path made the button look broken even when the API
          // was perfectly happy to write the override.
          const markTouchCustomerIds = selectedRows
            .map((r) => r.customer_id ?? "")
            .filter(Boolean);
          const targetStatus =
            subtab === "followup" ? "follow_up_sent" : "touched";
          const markTouched = async () => {
            if (markTouchCustomerIds.length === 0) {
              setTouchReport(
                "No selectable past-due rows in your selection (rows need a Stripe customer_id to be markable)."
              );
              return;
            }
            setTouchBusy(true);
            setTouchReport(null);
            try {
              const r = await fetch("/api/past-due/outreach", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  customer_ids: markTouchCustomerIds,
                  status: targetStatus,
                }),
              });
              if (!r.ok) {
                const body = (await r
                  .json()
                  .catch(() => ({}))) as { error?: string };
                throw new Error(body.error ?? `HTTP ${r.status}`);
              }
              reloadOutreach();
              setTouchReport(
                `Marked ${markTouchCustomerIds.length} account${
                  markTouchCustomerIds.length === 1 ? "" : "s"
                } as ${
                  targetStatus === "follow_up_sent"
                    ? "follow-up sent"
                    : "touched"
                }.`
              );
              // Clear the selection so the user has a clean slate
              // for the next batch.
              setSelected(new Set());
            } catch (e) {
              setTouchReport(
                `Mark touched failed: ${
                  e instanceof Error ? e.message : "unknown error"
                }`
              );
            } finally {
              setTouchBusy(false);
              // Toast lingers long enough to read but doesn't persist
              // across unrelated workflows.
              setTimeout(() => setTouchReport(null), 6_000);
            }
          };
          if (subtab === "below") {
            // Under-$3.5K rows use the BCC-bundled LowTierBulkSend
            // instead of per-customer Gmail drafts, but the AM still
            // needs the manual "Mark touched" affordance for rows
            // they emailed outside the dash (Loops, ad-hoc reply,
            // etc.). Same handler the higher tiers use — q24620's
            // customer_id IS the Stripe ID so no book lookup needed.
            return (
              <>
                <LowTierBulkSend
                  customers={selectedCustomers}
                  settings={settings}
                  disabled={
                    selected.size === 0 || customerBook.length === 0
                  }
                  onSent={() => reloadOutreach()}
                />
                <button
                  onClick={() => void markTouched()}
                  disabled={selected.size === 0 || touchBusy}
                  className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
                  title="Mark selected as Touched (first outreach sent — e.g. handled via Loops or another channel)"
                >
                  {touchBusy
                    ? "Marking…"
                    : `✓ Mark touched${
                        markTouchCustomerIds.length > 0
                          ? ` (${markTouchCustomerIds.length})`
                          : ""
                      }`}
                </button>
              </>
            );
          }
          // Enterprise + Above + Follow-Up all use BulkEmailLauncher.
          // Enterprise adds CC-CSM via the ccLookup prop.
          return (
            <>
              <BulkEmailLauncher
                customers={selectedCustomers}
                defaultTemplateId={
                  subtab === "followup"
                    ? "general-checkin"
                    : "general-checkin"
                }
                disabled={
                  selected.size === 0 || customerBook.length === 0
                }
                label={
                  subtab === "followup"
                    ? "↻ Follow-up email"
                    : "✉️ Email selected"
                }
                ccLookup={
                  subtab === "enterprise"
                    ? (c) => c.customer_success_manager_email ?? null
                    : undefined
                }
                trackingIdFor={(c) => c.stripe_customer_id ?? null}
                onDraftCreated={async (ids) => {
                  // Auto-stamp "touched" (or "follow_up_sent" on the
                  // Follow-Up sub-tab) for every customer whose draft
                  // ACTUALLY landed in Gmail (the bulk-create route
                  // now returns succeeded_tracking_ids, so this list
                  // excludes the partial-failure overstamping the
                  // older code path produced).
                  if (ids.length === 0) return;
                  const targetStatus =
                    subtab === "followup" ? "follow_up_sent" : "touched";
                  console.log("[past-due] Auto-stamp after drafts", {
                    subtab,
                    count: ids.length,
                    targetStatus,
                  });
                  try {
                    const r = await fetch("/api/past-due/outreach", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        customer_ids: ids,
                        status: targetStatus,
                      }),
                    });
                    if (r.ok) {
                      reloadOutreach();
                    } else {
                      const body = (await r
                        .json()
                        .catch(() => ({}))) as { error?: string };
                      console.warn(
                        "[past-due] Auto-stamp failed",
                        body.error ?? `HTTP ${r.status}`
                      );
                    }
                  } catch (e) {
                    console.warn(
                      "[past-due] Auto-stamp threw",
                      e instanceof Error ? e.message : e
                    );
                    /* non-fatal — manual button still works as fallback */
                  }
                }}
              />
              <button
                onClick={() => void markTouched()}
                disabled={selected.size === 0 || touchBusy}
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
                title={
                  subtab === "followup"
                    ? "Mark selected as Follow-Up Sent"
                    : "Mark selected as Touched (first outreach sent)"
                }
              >
                {touchBusy
                  ? "Marking…"
                  : subtab === "followup"
                    ? `✓ Mark follow-up sent${
                        markTouchCustomerIds.length > 0
                          ? ` (${markTouchCustomerIds.length})`
                          : ""
                      }`
                    : `✓ Mark touched${
                        markTouchCustomerIds.length > 0
                          ? ` (${markTouchCustomerIds.length})`
                          : ""
                      }`}
              </button>
            </>
          );
        })()}
        <button
          onClick={async () => {
            setHistoryBusy(true);
            setHistoryReport(null);
            try {
              const r = await fetch("/api/past-due/history/sweep", {
                method: "POST",
              });
              const j = (await r.json()) as {
                ok?: boolean;
                error?: string;
                episodes_opened?: number;
                episodes_closed?: number;
                episodes_updated?: number;
                customers_tracked?: number;
              };
              if (!r.ok || !j.ok) {
                throw new Error(j.error ?? `HTTP ${r.status}`);
              }
              const bits: string[] = [];
              if (j.episodes_opened)
                bits.push(`opened ${j.episodes_opened}`);
              if (j.episodes_closed)
                bits.push(`closed ${j.episodes_closed}`);
              if (j.episodes_updated)
                bits.push(`updated ${j.episodes_updated}`);
              bits.push(`${j.customers_tracked ?? 0} customers tracked`);
              setHistoryReport(`History reconciled — ${bits.join(" · ")}`);
              reloadHistory();
            } catch (e) {
              setHistoryReport(
                `History sweep failed: ${
                  e instanceof Error ? e.message : "unknown"
                }`
              );
            } finally {
              setHistoryBusy(false);
              setTimeout(() => setHistoryReport(null), 8000);
            }
          }}
          disabled={historyBusy}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
          title="Reconcile past-due episode history against the current q24620 snapshot. Same logic the daily cron runs."
        >
          {historyBusy ? "Reconciling…" : "🕓 Refresh history"}
        </button>
        <SendDigestButton workflows={["past_due"]} />

        <button
          onClick={() => setComposeOpen(true)}
          disabled={!settings || selected.size === 0}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          title="Send a Slack message about the selected past-due accounts"
        >
          📣 Slack the past-due channel
        </button>
      </div>

      {historyReport ? (
        <div className="text-xs text-muted mb-3">{historyReport}</div>
      ) : null}
      {touchReport ? (
        <div
          className={`text-xs px-3 py-2 mb-3 rounded-md border ${
            touchReport.startsWith("Marked")
              ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-200"
              : "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-800 dark:text-red-300"
          }`}
        >
          {touchReport}
        </div>
      ) : null}

      {grouped.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          {subtab === "followup"
            ? "Nobody's mid-outreach right now. Send a touch from another tier to start tracking."
            : subtab === "enterprise"
              ? "No past-due Enterprise accounts. Nicely done."
              : subtab === "above"
                ? "No past-due accounts above $3.5K ARR."
                : "No past-due accounts below $3.5K ARR."}
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(({ bucket, list }) => (
            <BucketSection
              key={bucket.label}
              label={bucket.label}
              count={list.length}
              detail={`${fmtCurrency(
                list.reduce((s, r) => s + r.arr_dollars, 0)
              )} ARR`}
              toneClass={bucket.toneClass}
              defaultOpen
            >
              <div className="px-3 py-1.5 border-b border-border flex justify-end">
                <button
                  onClick={() => selectAllIn(list)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Select all in bucket
                </button>
              </div>
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-8" />
                  {/* Expand chevron */}
                  <col className="w-6" />
                  <col className="w-[20%]" />
                  <col className="w-[16%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                  <col className="w-[12%]" />
                  <col className="w-[10%]" />
                  {/* Review dropdown — drives the digest workflow. */}
                  <col className="w-[11%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs text-muted border-b border-border text-left">
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 font-medium text-right">ARR</th>
                    <th className="px-3 py-2 font-medium text-right">
                      Failed charge
                    </th>
                    <th className="px-3 py-2 font-medium">Attempted</th>
                    <th className="px-3 py-2 font-medium">CSM</th>
                    <th className="px-3 py-2 font-medium">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => {
                    const k = rowKey(r, i);
                    const isEnt = isEnterprisePlan(r);
                    const isOpen = expanded.has(k);
                    // Resolve to the canonical Customer record so the
                    // detail panel + notes editor have the full set
                    // of workspace fields. Fallback chain:
                    //   1. Customer book (q10600) — full record.
                    //   2. Stripe → workspace index + synthesize a
                    //      minimal Customer from the row data. Covers
                    //      non-ENT accounts that q10600 doesn't carry
                    //      (most past-due Below $3.5K rows).
                    //   3. Synthesize without workspace_id — notes
                    //      won't work but the rest of the panel reads
                    //      cleanly instead of an error message.
                    const booked = r.customer_id
                      ? customerByStripeId.get(r.customer_id) ?? null
                      : null;
                    const resolvedCustomer = booked
                      ? booked
                      : synthesizeCustomer({
                          workspace_id: r.customer_id
                            ? stripe2ws[r.customer_id] ?? null
                            : null,
                          owner_email: r.email,
                          stripe_customer_id: r.customer_id,
                          customer_success_manager:
                            r.customer_success_manager,
                          stripe_plan: r.price_name,
                          arr: r.arr_dollars,
                        });
                    return (
                      <Fragment key={k}>
                      <tr
                        onClick={() => toggleExpanded(k)}
                        className={`border-b border-border cursor-pointer align-top ${
                          isOpen
                            ? "bg-blue-50 dark:bg-blue-500/40"
                            : "hover:bg-blue-50 dark:hover:bg-blue-500/30"
                        }`}
                      >
                        <td
                          className="px-3 py-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(k)}
                            onChange={() => toggleSelected(k)}
                            className="h-4 w-4 rounded border-border-strong cursor-pointer"
                            aria-label={`Select ${r.email ?? "row"}`}
                          />
                        </td>
                        <td className="px-3 py-2 text-subtle select-none">
                          <span
                            aria-hidden
                            className={`inline-block transition-transform ${
                              isOpen ? "rotate-90" : ""
                            }`}
                          >
                            ▸
                          </span>
                        </td>
                        <td className="px-3 py-2 break-words">
                          {(() => {
                            const histEntry = r.customer_id
                              ? historyMap[r.customer_id]
                              : undefined;
                            const months = histEntry
                              ? monthsObserved(histEntry)
                              : 0;
                            const isHistoryOpen = r.customer_id
                              ? historyOpen.has(r.customer_id)
                              : false;
                            const hasHistory =
                              histEntry && histEntry.episodes.length > 0;
                            const toggleHistory = (e: React.MouseEvent) => {
                              e.stopPropagation();
                              if (!r.customer_id || !hasHistory) return;
                              setHistoryOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.customer_id!)) {
                                  next.delete(r.customer_id!);
                                } else {
                                  next.add(r.customer_id!);
                                }
                                return next;
                              });
                            };
                            return (
                              <>
                                <div className="font-medium text-fg flex items-center gap-1.5 flex-wrap">
                                  {hasHistory ? (
                                    <button
                                      type="button"
                                      onClick={toggleHistory}
                                      className="text-left hover:underline cursor-pointer decoration-dotted"
                                      title={`${months} month${months === 1 ? "" : "s"} past-due across ${histEntry.episodes.length} episode${histEntry.episodes.length === 1 ? "" : "s"} — click for history`}
                                    >
                                      {r.email ?? "—"}
                                    </button>
                                  ) : (
                                    <span>{r.email ?? "—"}</span>
                                  )}
                                  <OutreachStatusBadge
                                    status={
                                      r.customer_id
                                        ? outreachMap[r.customer_id]?.status
                                        : undefined
                                    }
                                  />
                                  {/* Notes affordance: shows N notes
                                   *  (or "+ note" when empty) and routes
                                   *  the click into the same row-expand
                                   *  toggle the chevron uses, so the
                                   *  CompanyNotes editor in the detail
                                   *  panel becomes visible immediately. */}
                                  <NotesChip
                                    workspaceId={
                                      resolvedCustomer?.workspace_id ?? null
                                    }
                                    onClick={() => toggleExpanded(k)}
                                  />
                                  {months > 0 ? (
                                    <button
                                      type="button"
                                      onClick={toggleHistory}
                                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                        months >= 3
                                          ? "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200"
                                          : months >= 2
                                            ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
                                            : "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200"
                                      }`}
                                      title="Click for full episode history"
                                    >
                                      {months} mo past-due
                                    </button>
                                  ) : null}
                                </div>
                                {r.customer_id ? (
                                  <a
                                    href={
                                      stripeCustomerUrl(r.customer_id) ?? "#"
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="block text-xs text-muted truncate font-mono hover:text-accent hover:underline decoration-dotted"
                                    title="Open in Stripe Dashboard"
                                  >
                                    {r.customer_id}
                                  </a>
                                ) : null}
                                {isHistoryOpen && histEntry ? (
                                  <EpisodeHistoryList entry={histEntry} />
                                ) : null}
                              </>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2 text-muted break-words">
                          <div>{r.price_name ?? "—"}</div>
                          {isEnt ? (
                            <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:text-emerald-300">
                              ENT
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {fmtCurrency(r.arr_dollars)}
                        </td>
                        <td className="px-3 py-2 text-right text-red-700 font-medium">
                          {fmtCurrency(r.charge_amount_dollars)}
                          {r.failure_code ? (
                            <div className="text-[10px] text-muted">
                              {r.failure_code}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-muted text-xs">
                          {fmtDate(r.charge_attempted_at)}
                        </td>
                        <td className="px-3 py-2 text-muted break-words">
                          {r.customer_success_manager?.replace(/_/g, " ") ?? (
                            <span className="text-subtle italic">
                              unassigned
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <ReviewStateCell
                            workspaceId={
                              resolvedCustomer?.workspace_id ?? null
                            }
                            workflow="past_due"
                            current={
                              resolvedCustomer?.workspace_id
                                ? reviewStates[resolvedCustomer.workspace_id]
                                : undefined
                            }
                            onChange={(next) => {
                              if (resolvedCustomer?.workspace_id) {
                                onReviewChange(
                                  resolvedCustomer.workspace_id,
                                  next
                                );
                              }
                            }}
                          />
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="bg-blue-50/40 dark:bg-blue-500/10 border-b border-border">
                          <td colSpan={9} className="px-6 py-4">
                            <CustomerDetailPanel customer={resolvedCustomer} />
                            {!booked && !resolvedCustomer.workspace_id ? (
                              <p className="text-[11px] text-subtle italic mt-2">
                                This account isn&rsquo;t in the customer
                                book and we couldn&rsquo;t map its
                                Stripe ID to a workspace, so the Notes
                                + Publications sections aren&rsquo;t
                                available. The rest of the row data is
                                from q24620.
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </BucketSection>
          ))}
        </div>
      )}

      <p className="text-xs text-subtle mt-2">
        Source: Metabase q24620 — past-due subscriptions with customer details.
        ARR / charge amounts converted from cents.
      </p>

      {composeOpen && settings ? (() => {
        // Pre-render the bulk-compose inputs from the selected rows so
        // the shared modal stays generic. Past-due uses the past_due
        // channel config from /settings/slack — both the combined
        // body template and the per-row format come from there.
        // Sort by CSM before rendering so the Slack channel gets
        // contiguous per-owner blocks instead of mixed messages.
        // Within a CSM, sort by ARR descending so the biggest accounts
        // lead. Unassigned rows go to the end.
        const selectedRows = rows
          .filter((r, i) => selected.has(rowKey(r, i)))
          .slice()
          .sort((a, b) => {
            const aCsm = a.customer_success_manager ?? "￿";
            const bCsm = b.customer_success_manager ?? "￿";
            if (aCsm !== bCsm) return aCsm.localeCompare(bCsm);
            return b.arr_dollars - a.arr_dollars;
          });
        const pastDueCfg = findSlackChannel(
          settings.slack,
          PAST_DUE_CHANNEL_ID
        );
        const rowTemplate = (pastDueCfg?.row_template ?? "").trim()
          ? (pastDueCfg!.row_template as string)
          : DEFAULT_PAST_DUE_ROW_TEMPLATE;
        const perCompany: BulkSlackMessage[] = selectedRows.map((r, i) => ({
          id: rowKey(r, i),
          label: r.email ?? r.customer_id ?? `Row ${i + 1}`,
          text: renderPastDueRow(r, rowTemplate, settings),
        }));
        const combined = renderSlackTemplate(
          pastDueCfg?.template ?? "",
          selectedRows,
          settings,
          pastDueCfg?.row_template
        );
        return (
          <SlackBulkCompose
            title="Slack the past-due channel"
            initialChannel={pastDueCfg?.channel_id ?? ""}
            initialCombinedText={combined}
            perCompanyMessages={perCompany}
            defaultMode="per-company"
            onClose={() => setComposeOpen(false)}
          />
        );
      })() : null}
    </>
  );
}

/** Compact lifecycle status pill rendered inline with the customer
 *  email cell. Invisible when there's no stored outreach status, so
 *  untouched rows render the same as before. */
/** Expanded episode history shown below a row when the user clicks
 *  the email / months-past-due chip. Renders each past-due episode
 *  with its start/end dates, failure count, and plan at the time. */
function EpisodeHistoryList({
  entry,
}: {
  entry: import("@/lib/data/past-due-history-types").PastDueHistoryEntry;
}) {
  // Most-recent episodes at the top so what just happened is at eye
  // level. Active episodes (no end date) sort first.
  const sorted = [...entry.episodes].sort((a, b) => {
    if (a.episode_ended_at === null) return -1;
    if (b.episode_ended_at === null) return 1;
    return b.episode_started_at.localeCompare(a.episode_started_at);
  });
  return (
    <div className="mt-2 mb-1 rounded-md border border-border bg-canvas/40 p-2 space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Past-due history ({entry.episodes.length} episode
        {entry.episodes.length === 1 ? "" : "s"})
      </div>
      <ul className="space-y-1">
        {sorted.map((ep, i) => {
          const active = ep.episode_ended_at === null;
          return (
            <li
              key={`${ep.episode_started_at}-${i}`}
              className="text-xs flex items-baseline gap-2 flex-wrap"
            >
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  active
                    ? "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200"
                    : "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200"
                }`}
              >
                {active ? "Active" : "Resolved"}
              </span>
              <span className="text-fg font-medium">
                {ep.episode_started_at}
                {ep.episode_ended_at ? ` → ${ep.episode_ended_at}` : " → now"}
              </span>
              <span className="text-muted">
                {ep.failure_count} failed charge
                {ep.failure_count === 1 ? "" : "s"} ·{" "}
                {fmtCurrency(ep.max_arr_dollars)} ARR
                {ep.plan ? ` · ${ep.plan}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OutreachStatusBadge({
  status,
}: {
  status?: PastDueOutreachStatus;
}) {
  if (!status) return null;
  const styles: Record<
    PastDueOutreachStatus,
    { label: string; cls: string; icon: string }
  > = {
    // First-touch / follow-up = green ✓ — surfaces as the
    // "draft created" indicator the brief calls for.
    touched: {
      label: "Outreach sent",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
      icon: "✓",
    },
    follow_up_sent: {
      label: "Follow-up sent",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
      icon: "✓",
    },
    paid: {
      label: "Paid",
      cls: "bg-slate-100 text-slate-700 dark:bg-slate-500/30 dark:text-slate-200",
      icon: "$",
    },
    lost: {
      label: "Lost",
      cls: "bg-slate-200 text-slate-800 dark:bg-slate-500/30 dark:text-slate-200",
      icon: "✗",
    },
  };
  const s = styles[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${s.cls}`}
    >
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        accent
          ? "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30"
          : "bg-surface border-border"
      }`}
    >
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold mt-0.5">{value}</p>
    </div>
  );
}

/** ----------------- Slack compose modal ----------------- */

/** Default per-row format used when settings.slack.channels[past_due]
 *  has no row_template. Kept in sync with DEFAULTS in settings-types
 *  so freshly-seeded envs render identically to upgraded ones. */
const DEFAULT_PAST_DUE_ROW_TEMPLATE =
  "• *{{email}}* — {{charge_amount}} failed charge, {{arr}} ARR (CSM: {{csm}})";

function csmTagFor(
  csmKey: string | null,
  settings: SettingsShape
): string {
  const key = csmKey ?? "";
  const slackId = settings.slack.csm_user_ids[key];
  if (slackId) return `<@${slackId}>`;
  return (key || "unassigned").replace(/_/g, " ");
}

/** Render a single past-due row through the per-row template. Unknown
 *  tokens render empty so a typo in settings doesn't echo `{{foo}}` out
 *  into a Slack message. */
function renderPastDueRow(
  row: PastDueRow,
  template: string,
  settings: SettingsShape
): string {
  const values: Record<string, string> = {
    email: row.email ?? "—",
    customer_id: row.customer_id ?? "",
    subscription_id: row.subscription_id ?? "",
    plan: row.price_name ?? "—",
    arr: fmtCurrency(row.arr_dollars),
    charge_amount: fmtCurrency(row.charge_amount_dollars),
    charge_status: row.charge_status ?? "",
    failure_code: row.failure_code ?? "",
    failure_message: row.failure_message ?? "",
    attempted_at: row.charge_attempted_at
      ? fmtDate(row.charge_attempted_at)
      : "",
    csm: csmTagFor(row.customer_success_manager, settings),
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    return name in values ? values[name] : "";
  });
}

function renderSlackTemplate(
  template: string,
  rows: PastDueRow[],
  settings: SettingsShape,
  rowTemplate?: string
): string {
  const total = rows.reduce((s, r) => s + r.arr_dollars, 0);
  const effectiveRowTemplate = (rowTemplate ?? "").trim()
    ? (rowTemplate as string)
    : DEFAULT_PAST_DUE_ROW_TEMPLATE;
  const accountList = rows
    .map((r) => renderPastDueRow(r, effectiveRowTemplate, settings))
    .join("\n");
  // Comma-separated list of Stripe customer IDs from the selected rows.
  // Filter to ids that actually start with `cus_` so junk values (null,
  // legacy IDs) don't leak into a paste-into-Stripe workflow.
  const customerIds = rows
    .map((r) => r.customer_id)
    .filter((id): id is string => !!id && id.startsWith("cus_"))
    .join(", ");
  return template
    .replace(/\{\{\s*total_arr\s*\}\}/g, fmtCurrency(total))
    .replace(/\{\{\s*count\s*\}\}/g, String(rows.length))
    .replace(/\{\{\s*count_plural\s*\}\}/g, rows.length === 1 ? "" : "s")
    .replace(/\{\{\s*account_list\s*\}\}/g, accountList)
    .replace(/\{\{\s*customer_ids\s*\}\}/g, customerIds);
}

// SlackCompose was inlined here before — replaced by the shared
// <SlackBulkCompose> in ./slack-bulk-compose.tsx, which supports
// per-company sends as well as the original combined-digest mode.
