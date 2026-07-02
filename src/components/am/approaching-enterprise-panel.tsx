"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ApproachingEntRow } from "@/lib/engines/am-cohorts";
import { fmtCurrency, fmtDate, fmtNumber, fmtPct } from "../format";
import { BucketSection } from "./bucket-section";
import {
  SlackBulkCompose,
  type BulkSlackMessage,
} from "./slack-bulk-compose";
import { BulkEmailLauncher } from "./bulk-email-launcher";
import { NotesChip } from "./notes-chip";
import { ReviewStateCell } from "./review-state-cell";
import { CopyPubIdsButton } from "./copy-pub-ids-button";
import { CustomerDetailPanel } from "../customer-detail-panel";
import {
  FeatureUtilizationFilter,
  type WorkspaceFeatureMatcher,
} from "../feature-utilization-filter";
import {
  needsReview,
  type ReviewState,
  type ReviewStatesMap,
} from "@/lib/data/review-states-types";
import { SearchInput, SelectFilter } from "../filters";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import { useStripeCustomerIndex } from "@/lib/hooks/use-stripe-customer-index";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { synthesizeCustomer } from "@/lib/data/synthesize-customer";
import type { SettingsShape } from "@/lib/data/settings-types";
import type { Customer } from "@/lib/types";

/**
 * Defaults used when there's no `approaching_enterprise` channel
 * configured at /settings/slack yet. Mirrors the past-due defaults —
 * the user can override either template through the settings UI.
 */
const DEFAULT_APPROACHING_TEMPLATE =
  "*Approaching Enterprise threshold*\n\n*{{count}}* account{{count_plural}} approaching or exceeding their plan cap:\n\n{{account_list}}\n\nHeads-up to the AM team to start the upsell conversation.";
const DEFAULT_APPROACHING_ROW_TEMPLATE =
  "• *{{workspace_name}}* — {{pct_cap}} of cap ({{subs}}/{{cap}} subs) on {{plan}}. Owner: {{owner_email}}";

/** Render a single Approaching row through the per-row template. Unknown
 *  tokens render empty so a typo in settings doesn't echo `{{foo}}` out
 *  into a Slack message. */
function renderApproachingRow(
  row: ApproachingEntRow,
  template: string
): string {
  const pct = pctNum(row);
  const values: Record<string, string> = {
    workspace_name: row.workspace_name ?? "—",
    owner_email: row.owner_email ?? "",
    owner_name: row.owner_name ?? "",
    plan: row.plan_name ?? "—",
    price: priceLabel(row),
    subs: fmtNumber(row.total_subscriptions),
    cap: fmtNumber(row.max_subscriptions),
    pct_cap: fmtPct(pct),
    last_send: row.last_send ? fmtDate(row.last_send) : "—",
    last_payment: row.last_payment_at ? fmtDate(row.last_payment_at) : "—",
    masquerade_url: row.masquerade_url ?? "",
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    return name in values ? values[name] : "";
  });
}

interface Props {
  rows: ApproachingEntRow[];
}

interface Bucket {
  label: string;
  test: (pct: number) => boolean;
  color: string;
}

// Non-Enterprise cohort uses 10% segments per the AM brief follow-up —
// 80-89%, 90-99%, ≥100%. Above 100% is the "over the plan cap" case
// (customer is paying the overage; conversion is urgent); 90-99% is
// the imminent-upgrade conversation; 80-89% is the warm-pitch window.
const BUCKETS: Bucket[] = [
  {
    label: "≥100% — over cap",
    test: (p) => p >= 100,
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
  },
  {
    label: "90–99%",
    test: (p) => p >= 90 && p < 100,
    color: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900",
  },
  {
    label: "80–89%",
    test: (p) => p >= 80 && p < 90,
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
  },
];

/** q13268's percent_to is a fraction (0.875 = 87.5%, 1.43 = 143%). */
function pctNum(r: ApproachingEntRow): number | null {
  if (r.percent_to == null) return null;
  return r.percent_to * 100;
}

function priceLabel(r: ApproachingEntRow): string {
  if (r.last_payment_amount == null) return "—";
  const interval = (r.billing_interval ?? "").toLowerCase();
  const suffix =
    interval === "month" || interval === "monthly" ? "/mo" : "/yr";
  return `${fmtCurrency(r.last_payment_amount)}${suffix}`;
}

export function ApproachingEnterprisePanel({ rows }: Props) {
  const [search, setSearch] = useState("");
  // Feature-usage chip filter — matches the At-Risk / Customer table
  // pattern. Emits a matcher over workspace_id (== organization_id
  // for q13268 rows) that we apply during bucketing below.
  const [featureMatcher, setFeatureMatcher] =
    useState<WorkspaceFeatureMatcher | null>(null);
  const onFeatureFilterChange = useCallback(
    (matcher: WorkspaceFeatureMatcher | null) => {
      setFeatureMatcher(() => matcher);
    },
    []
  );
  const featureWorkspaceIds = useMemo(
    () =>
      rows
        .map((r) => r.organization_id)
        .filter((id): id is string => Boolean(id)),
    [rows]
  );
  // Bulk-select state mirrors past-due-panel: row keys in a Set.
  // Row key is organization_id with a stable fallback so rows without
  // an id still de-dupe predictably across re-renders.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const reloadOutreach = useCallback(() => {
    fetch("/api/proactive-outreach").catch(() => {});
  }, []);
  // Per-row expand state — clicking the row toggles a full
  // CustomerDetailPanel below (notes + status + dates + …),
  // matching /csm CustomerTable.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-workflow review state map for the digest workflow. Cell
  // changes update locally so the dropdown reflects immediately.
  const [reviewStates, setReviewStates] = useState<ReviewStatesMap>({});
  const [needsReviewFilter] = useUrlSearch("needs_review");
  // Per-state filter for the Review column (digest workflow). Mirrors
  // the Enterprise Only panel — overrides the broader needs_review=1
  // hint when set, so deep-links from the digest land here exactly.
  const [reviewFilter, setReviewFilter] = useUrlSearch("review");
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
        delete current.proactive;
      } else {
        current.proactive = {
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

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setSettings(j as SettingsShape))
      .catch(() => {});
  }, []);

  // Customer book for the bulk-email launcher (see same pattern in
  // past-due-panel). Approaching rows index by stripe_customer_id.
  const [customerBook, setCustomerBook] = useState<Customer[]>([]);
  useEffect(() => {
    fetch("/api/customers")
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => setCustomerBook((list as Customer[]) ?? []))
      .catch(() => {});
  }, []);
  const customerByStripeId = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customerBook) {
      if (c.stripe_customer_id) m.set(c.stripe_customer_id, c);
    }
    return m;
  }, [customerBook]);

  function rowKey(r: ApproachingEntRow, i: number): string {
    return r.organization_id ?? r.workspace_name ?? `row-${i}`;
  }

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // Publication-index — supports pasting a `pub_*` / workspace UUID
  // into the search input and finding the matching row. Soft-fails
  // empty if the endpoint is down.
  const { ws2pubs } = usePublicationsIndex();
  // Stripe → workspace fallback for the customer-book miss case.
  // q13268 surfaces approaching-cap rows whether or not they're in
  // q10600; this lets us still resolve to a workspace_id (already
  // on the row as organization_id anyway, but reused here for
  // consistency with past-due).
  const { stripe2ws } = useStripeCustomerIndex();

  // Filter to ≥80% utilization, then bucket. q13268 returns customers
  // approaching the 100K Enterprise threshold — they're already a curated
  // pool, but per the AM brief follow-up we surface ≥80% in 10% segments
  // (80-89, 90-99, ≥100) so the panel focuses on the actionable window.
  const buckets = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows
      .filter((r) => {
        const p = pctNum(r);
        if (p == null || p < 80) return false;
        if (featureMatcher && !featureMatcher(r.organization_id)) return false;
        // Review-state filter takes precedence — when set, it's a
        // specific value (needs_review / reach_out / skip / done)
        // and overrides the broader needs_review=1 hint.
        if (reviewFilter) {
          const ws = r.organization_id ?? null;
          const entry = ws ? reviewStates[ws]?.proactive : undefined;
          if (reviewFilter === "needs_review") {
            if (entry) return false;
          } else if (entry?.state !== reviewFilter) {
            return false;
          }
        } else if (needsReviewFilter === "1") {
          // ?needs_review=1 → only rows still pending action.
          const ws = r.organization_id ?? null;
          if (ws && !needsReview(reviewStates[ws], "proactive")) return false;
        }
        if (!q) return true;
        // organization_id IS the workspace ID in beehiiv. Lookup
        // every publication owned by this workspace so a pasted
        // `pub_*` UUID surfaces its parent account.
        const orgId = r.organization_id ?? null;
        const pubs = orgId ? ws2pubs[orgId] ?? [] : [];
        // q13268 doesn't carry the CSM — resolve through the customer
        // book so "search by CSM" works the same as in Past Due.
        const resolved = r.stripe_customer_id
          ? customerByStripeId.get(r.stripe_customer_id)
          : null;
        const csm = resolved?.customer_success_manager?.replace(/_/g, " ");
        if (
          r.workspace_name?.toLowerCase().includes(q) ||
          r.owner_name?.toLowerCase().includes(q) ||
          r.owner_email?.toLowerCase().includes(q) ||
          orgId?.toLowerCase().includes(q) ||
          r.stripe_customer_id?.toLowerCase().includes(q) ||
          csm?.toLowerCase().includes(q)
        ) {
          return true;
        }
        return pubs.some((p) => p.toLowerCase().includes(q));
      })
      .sort((a, b) => (pctNum(b) ?? 0) - (pctNum(a) ?? 0));
    return BUCKETS.map((b) => ({
      bucket: b,
      list: filtered.filter((r) => {
        const p = pctNum(r);
        return p != null && b.test(p);
      }),
    })).filter((g) => g.list.length > 0);
  }, [
    rows,
    search,
    ws2pubs,
    customerByStripeId,
    needsReviewFilter,
    reviewFilter,
    reviewStates,
    featureMatcher,
  ]);

  const totalAtOrAboveFloor = rows.filter((r) => {
    const p = pctNum(r);
    return p != null && p >= 80;
  }).length;

  // Visible rows (after filter + sort + bucket) — used by the
  // "Select all visible" toolbar action so we don't select rows
  // that aren't in view.
  const visibleRows = useMemo(
    () => buckets.flatMap((g) => g.list),
    [buckets]
  );

  const selectedRows = useMemo(
    () => visibleRows.filter((r, i) => selected.has(rowKey(r, i))),
    [visibleRows, selected]
  );

  const selectedWorkspaceIds = useMemo(
    () =>
      selectedRows
        .map((r) => r.organization_id)
        .filter((id): id is string => Boolean(id)),
    [selectedRows]
  );

  return (
    <>
      <div className="mb-4">
        <FeatureUtilizationFilter
          workspaceIds={featureWorkspaceIds}
          onFilterChange={onFeatureFilterChange}
          totalRowCount={rows.length}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search workspace / owner / CSM / publication ID…"
        />
        <SelectFilter
          label="Review"
          value={reviewFilter}
          onChange={setReviewFilter}
          emptyLabel="Any"
          options={[
            { value: "needs_review", label: "Needs review" },
            { value: "reach_out", label: "Reach out" },
            { value: "skip", label: "Skip" },
            { value: "done", label: "Done" },
          ]}
        />
        <span className="text-xs text-muted ml-auto">
          {totalAtOrAboveFloor} of {rows.length} q13268 rows at ≥80% of plan limit
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-muted">
          <strong>{selected.size}</strong> selected
        </span>
        <button
          onClick={() =>
            setSelected(new Set(visibleRows.map((r, i) => rowKey(r, i))))
          }
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
          title="Select every visible row (after filters)"
        >
          Select all
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
        >
          Clear
        </button>
        <button
          onClick={async () => {
            if (selectedWorkspaceIds.length === 0) return;
            const r = await fetch("/api/proactive-outreach", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ workspace_ids: selectedWorkspaceIds }),
            });
            if (r.ok) reloadOutreach();
          }}
          disabled={selected.size === 0}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
          title="Stamp the selected rows as outreach-logged. Stops the 5-day nudge cycle for them."
        >
          ✓ Mark outreach logged
        </button>
        <CopyPubIdsButton workspaceIds={selectedWorkspaceIds} />
        <div className="flex-1" />
        <BulkEmailLauncher
          customers={selectedRows
            .map((r) =>
              r.stripe_customer_id
                ? customerByStripeId.get(r.stripe_customer_id)
                : null
            )
            .filter((c): c is Customer => Boolean(c))}
          // Approaching → upsell — use the dedicated template if it
          // exists, fall back to general-checkin.
          defaultTemplateId="approaching-ent"
          disabled={selected.size === 0 || customerBook.length === 0}
          label="✉️ Email selected"
          trackingIdFor={(c) => c.workspace_id ?? null}
          auditLabel="Approaching-Enterprise email sent"
          onDraftCreated={async (ids) => {
            if (ids.length === 0) return;
            try {
              const r = await fetch("/api/proactive-outreach", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspace_ids: ids }),
              });
              if (r.ok) reloadOutreach();
            } catch {
              /* non-fatal */
            }
          }}
        />
        <button
          onClick={() => setComposeOpen(true)}
          disabled={!settings || selected.size === 0}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          title="Send a Slack message about the selected accounts"
        >
          📣 Slack the channel
        </button>
      </div>

      {buckets.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No approaching-Enterprise accounts at ≥80% of their plan limit.
        </div>
      ) : (
        <div className="space-y-4">
          {buckets.map(({ bucket, list }) => (
            <BucketSection
              key={bucket.label}
              label={bucket.label}
              count={list.length}
              toneClass={bucket.color}
              defaultOpen
            >
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-8" />
                  {/* Expand chevron */}
                  <col className="w-6" />
                  <col className="w-[16%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                  <col className="w-[6%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  {/* Review dropdown — drives the digest workflow. */}
                  <col className="w-[11%]" />
                  {/* Actions — Masquerade + envelope. */}
                  <col className="w-[15%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs text-muted border-y border-border text-left">
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2 font-medium">Workspace</th>
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 font-medium text-right">Price</th>
                    <th className="px-3 py-2 font-medium text-right">
                      Subs / cap
                    </th>
                    <th className="px-3 py-2 font-medium text-right">% cap</th>
                    <th className="px-3 py-2 font-medium">Last send</th>
                    <th className="px-3 py-2 font-medium">Last payment</th>
                    <th className="px-3 py-2 font-medium">Review</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => {
                    const p = pctNum(r);
                    const k = rowKey(r, i);
                    const isChecked = selected.has(k);
                    const isOpen = expanded.has(k);
                    // Resolve to a Customer record for the detail panel.
                    // Fallback chain: book lookup → synthesize from row
                    // data. q13268 carries organization_id directly so
                    // workspace_id is available even when the book misses,
                    // keeping the notes editor functional.
                    const booked = r.stripe_customer_id
                      ? customerByStripeId.get(r.stripe_customer_id) ?? null
                      : null;
                    const resolvedCustomer = booked
                      ? booked
                      : synthesizeCustomer({
                          workspace_id:
                            r.organization_id ??
                            (r.stripe_customer_id
                              ? stripe2ws[r.stripe_customer_id] ?? null
                              : null),
                          workspace_name: r.workspace_name,
                          owner_email: r.owner_email,
                          owner_name: r.owner_name,
                          stripe_customer_id: r.stripe_customer_id,
                          stripe_plan: r.plan_name,
                          active_subs: r.total_subscriptions,
                          max_subscriptions: r.max_subscriptions,
                          interval: r.billing_interval,
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
                            checked={isChecked}
                            onChange={() => toggleSelected(k)}
                            className="h-4 w-4 rounded border-border-strong cursor-pointer"
                            aria-label={`Select ${r.workspace_name ?? "row"}`}
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
                          <div className="font-medium text-fg flex items-center gap-2 flex-wrap">
                            <span>{r.workspace_name ?? "—"}</span>
                            {/* Notes affordance — same pattern as Past
                             *  Due. Clicking expands the row to surface
                             *  the embedded CompanyNotes editor. */}
                            <NotesChip
                              workspaceId={
                                resolvedCustomer?.workspace_id ?? null
                              }
                              onClick={() => toggleExpanded(k)}
                            />
                          </div>
                          <div className="text-xs text-muted break-words">
                            {r.owner_name ?? r.owner_email ?? ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted">
                          {r.plan_name ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-muted">
                          {priceLabel(r)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted">
                          <div>{fmtNumber(r.total_subscriptions)}</div>
                          <div className="text-xs text-muted">
                            / {fmtNumber(r.max_subscriptions)}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-semibold">
                          {fmtPct(p)}
                        </td>
                        <td className="px-3 py-2 text-muted text-xs">
                          {fmtDate(r.last_send)}
                        </td>
                        <td className="px-3 py-2 text-muted text-xs">
                          {fmtDate(r.last_payment_at)}
                        </td>
                        <td
                          className="px-3 py-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ReviewStateCell
                            workspaceId={r.organization_id ?? null}
                            workflow="proactive"
                            current={
                              r.organization_id
                                ? reviewStates[r.organization_id]
                                : undefined
                            }
                            onChange={(next) => {
                              if (r.organization_id) {
                                onReviewChange(r.organization_id, next);
                              }
                            }}
                          />
                        </td>
                        <td
                          className="px-3 py-2 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center gap-1 justify-end">
                            {r.masquerade_url ? (
                              <a
                                href={r.masquerade_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Masquerade into workspace"
                                className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                              >
                                Masq
                              </a>
                            ) : null}
                            {r.owner_email ? (
                              <a
                                href={`mailto:${encodeURIComponent(
                                  r.owner_email
                                )}`}
                                title={`Email ${r.owner_email}`}
                                className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                              >
                                ✉️
                              </a>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="bg-blue-50/40 dark:bg-blue-500/10 border-b border-border">
                          <td colSpan={11} className="px-6 py-4">
                            <CustomerDetailPanel customer={resolvedCustomer} />
                            {!booked ? (
                              <p className="text-[11px] text-subtle italic mt-2">
                                This workspace isn&rsquo;t in the
                                customer book; the panel above is
                                rendering from q13268 row data.
                                {customerBook.length === 0
                                  ? " (Customer book still loading.)"
                                  : null}
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
        Source: Metabase q13268. Filter:{" "}
        <code className="font-mono bg-surface-2 px-1 rounded">
          percent_to ≥ 0.75
        </code>
        . Refresh the page to re-fetch (10-min in-process cache).
      </p>

      {composeOpen && settings ? (() => {
        // Pre-render combined + per-company Slack bodies from the
        // selected rows so the shared modal stays generic. Falls back
        // to baked-in defaults when /settings/slack hasn't been
        // configured for the approaching channel yet.
        // Sort by CSM before rendering so the Slack channel reads as
        // contiguous per-owner blocks. q13268 doesn't carry the CSM
        // directly — resolve through customerByStripeId (same path the
        // search haystack uses). Within a CSM, sort by utilization
        // descending so the most-urgent leads. Unassigned rows go last.
        const selectedRows = visibleRows
          .filter((r, i) => selected.has(rowKey(r, i)))
          .slice()
          .sort((a, b) => {
            const aCsm = a.stripe_customer_id
              ? customerByStripeId.get(a.stripe_customer_id)
                  ?.customer_success_manager ?? null
              : null;
            const bCsm = b.stripe_customer_id
              ? customerByStripeId.get(b.stripe_customer_id)
                  ?.customer_success_manager ?? null
              : null;
            const aKey = aCsm ?? "￿";
            const bKey = bCsm ?? "￿";
            if (aKey !== bKey) return aKey.localeCompare(bKey);
            return (pctNum(b) ?? 0) - (pctNum(a) ?? 0);
          });
        // Approaching uses its own row template; if a channel labelled
        // `approaching` exists in settings.slack.channels we honor its
        // template + row_template. Otherwise we use baked-in defaults.
        const cfg = settings.slack.channels.find(
          (c) => c.id === "approaching_enterprise"
        );
        const rowTemplate = (cfg?.row_template ?? "").trim()
          ? (cfg!.row_template as string)
          : DEFAULT_APPROACHING_ROW_TEMPLATE;
        const combinedTemplate = (cfg?.template ?? "").trim()
          ? (cfg!.template as string)
          : DEFAULT_APPROACHING_TEMPLATE;
        const accountList = selectedRows
          .map((r) => renderApproachingRow(r, rowTemplate))
          .join("\n");
        const combined = combinedTemplate
          .replace(/\{\{\s*count\s*\}\}/g, String(selectedRows.length))
          .replace(
            /\{\{\s*count_plural\s*\}\}/g,
            selectedRows.length === 1 ? "" : "s"
          )
          .replace(/\{\{\s*account_list\s*\}\}/g, accountList);
        const perCompany: BulkSlackMessage[] = selectedRows.map((r, i) => {
          // Resolve each row's CSM through the customer book (q13268
          // doesn't carry CSM directly — same path the digest already
          // uses for sorting). Slack ID lookup pulls from the
          // configured csm_user_ids map; rows where neither resolves
          // bucket into the "Unassigned" group in per-CSM mode.
          const resolved = r.stripe_customer_id
            ? customerByStripeId.get(r.stripe_customer_id)
            : null;
          const handle = resolved?.customer_success_manager ?? null;
          const slackId =
            handle && settings
              ? (settings.slack.csm_user_ids[handle] ?? null)
              : null;
          const companyLabel =
            r.workspace_name ?? r.owner_email ?? `Row ${i + 1}`;
          // q13268 emits percent_to as a fraction (0.875 = 87.5%, 1.43 =
          // over cap). Multiply when present, else fall back to deriving
          // it from total/max so the rollup line always has a number.
          const utilPct =
            r.percent_to != null
              ? Math.round(r.percent_to * 100)
              : r.total_subscriptions && r.max_subscriptions
                ? Math.round(
                    (r.total_subscriptions / r.max_subscriptions) * 100
                  )
                : null;
          const rollupLine =
            utilPct != null
              ? `${companyLabel} — ${utilPct}% of cap`
              : companyLabel;
          return {
            id: rowKey(r, i),
            label: companyLabel,
            text: renderApproachingRow(r, rowTemplate),
            csmHandle: handle,
            csmSlackId: slackId,
            csmRollupLine: rollupLine,
          };
        });
        const deepLinkBase =
          typeof window !== "undefined"
            ? `${window.location.origin}/am?tab=proactive`
            : `/am?tab=proactive`;
        return (
          <SlackBulkCompose
            title="Slack the AM channel"
            initialChannel={cfg?.channel_id ?? ""}
            initialCombinedText={combined}
            perCompanyMessages={perCompany}
            defaultMode="per-csm"
            deepLinkBase={deepLinkBase}
            rollupNoun="accounts"
            rollupContext="proactive outreach"
            // Admin-editable template from /settings/slack. Falls
            // back to the hard-coded default when unset.
            rollupTemplate={cfg?.rollup_template}
            createTodoOnRollup
            onClose={() => setComposeOpen(false)}
          />
        );
      })() : null}
    </>
  );
}
