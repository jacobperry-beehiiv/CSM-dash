"use client";

import { useEffect, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtDate, fmtCurrency } from "../format";
import { OutreachModal } from "../outreach-modal";
import type {
  CustomerImpactLabel,
  EnterpriseRequestDerivedState,
  NeedsReviewReason,
  NotifiedEntry,
  PromotionConfidence,
  PromotionSource,
  WorkTypeLabel,
} from "@/lib/data/enterprise-requests-types";

/**
 * "Live requests" tab body — shipped feature requests grouped by
 * Linear ticket, with every attached customer listed under it.
 *
 * Replaces the old "Live This Week" queue, which hardcoded a 7-day
 * window and rendered one row per (customer, ticket). That shape
 * answered "what do I owe outreach on", but couldn't answer "what
 * shipped recently and who asked for it" — a ticket wanted by four
 * accounts read as four unrelated lines. Grouping happens in
 * /api/enterprise-requests/live-requests; the snapshot keeps its
 * per-customer shape for the profile lookup.
 *
 * Out-of-scope customers (other CSMs' accounts attached to the same
 * ticket) render as muted context rows without action controls —
 * knowing a fix also landed for three other accounts is useful, and
 * hiding them would make the customer count wrong.
 */

interface GroupCustomer {
  workspace_id: string;
  workspace_name: string | null;
  company_name: string | null;
  csm_handle: string | null;
  in_scope: boolean;
  notified: NotifiedEntry;
  arr_snapshot: number | null;
  customer_impact: CustomerImpactLabel | null;
  submitted_at: string | null;
  submitting_csm_email: string | null;
}

interface TicketGroup {
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  url: string;
  derived_state: EnterpriseRequestDerivedState;
  work_type: WorkTypeLabel | null;
  promotion_source: PromotionSource | null;
  promotion_confidence: PromotionConfidence;
  needs_review_reason: NeedsReviewReason | null;
  ship_url: string | null;
  ship_date: string | null;
  promoted_at: string | null;
  customers: GroupCustomer[];
  customer_count: number;
  in_scope_count: number;
  total_arr: number;
}

interface ApiResponse {
  csm: string;
  window: string;
  confidence: string;
  groups: TicketGroup[];
  count: number;
  in_scope_pairs: number;
  last_synced_at: string;
}

interface Props {
  /** CSM handle (or email) to scope to. Empty = the viewer. */
  csmParam: string | null;
  /** Book indexed by workspace_id so the Draft-outreach modal can
   *  open with the full Customer record without an extra fetch. */
  customersByWorkspace: Record<string, Customer>;
}

const WINDOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export function LiveRequests({ csmParam, customersByWorkspace }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState("30d");
  const [scopeAll, setScopeAll] = useState(false);
  const [showNotified, setShowNotified] = useState(false);
  const [includeNeedsReview, setIncludeNeedsReview] = useState(false);
  const [drafting, setDrafting] = useState<{
    group: TicketGroup;
    customer: GroupCustomer;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    qs.set("csm", scopeAll ? "all" : (csmParam ?? ""));
    qs.set("window", windowKey);
    if (showNotified) qs.set("include_notified", "1");
    if (includeNeedsReview) qs.set("confidence", "all");
    fetch(`/api/enterprise-requests/live-requests?${qs}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ApiResponse;
      })
      .then((body) => !cancelled && setData(body))
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "load failed");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [csmParam, windowKey, scopeAll, showNotified, includeNeedsReview]);

  /** Patch one customer's notified state inside the grouped shape. */
  function patchNotified(
    issueId: string,
    workspaceId: string,
    entry: NotifiedEntry
  ) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            groups: prev.groups.map((g) =>
              g.linear_issue_id !== issueId
                ? g
                : {
                    ...g,
                    customers: g.customers.map((c) =>
                      c.workspace_id === workspaceId
                        ? { ...c, notified: entry }
                        : c
                    ),
                  }
            ),
          }
        : prev
    );
  }

  async function markNotified(
    group: TicketGroup,
    customer: GroupCustomer,
    notified: boolean
  ) {
    const before = customer.notified;
    patchNotified(
      group.linear_issue_id,
      customer.workspace_id,
      notified ? { ...before, notified_at: new Date().toISOString() } : {}
    );
    try {
      const r = await fetch("/api/enterprise-requests/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: customer.workspace_id,
          linear_issue_id: group.linear_issue_id,
          action: notified ? "notified" : "cleared",
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      patchNotified(group.linear_issue_id, customer.workspace_id, before);
      console.warn("[live-requests] notify failed", e);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted max-w-prose">
        Feature requests that shipped, grouped by Linear ticket so you
        can see every customer who asked for it. Draft a note to close
        the loop, then check Notified so the row drops off the weekly
        digest.
      </p>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
        <label className="inline-flex items-center gap-1.5 text-xs text-fg">
          <span className="text-muted">Shipped</span>
          <select
            value={windowKey}
            onChange={(e) => setWindowKey(e.currentTarget.value)}
            className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="inline-flex items-center gap-1.5 text-xs text-fg cursor-pointer select-none">
          <input
            type="checkbox"
            checked={scopeAll}
            onChange={(e) => setScopeAll(e.currentTarget.checked)}
            className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
          />
          All accounts (not just my book)
        </label>

        <label className="inline-flex items-center gap-1.5 text-xs text-fg cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showNotified}
            onChange={(e) => setShowNotified(e.currentTarget.checked)}
            className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
          />
          Show already-notified
        </label>

        <label
          className="inline-flex items-center gap-1.5 text-xs text-fg cursor-pointer select-none"
          title="Include ships we couldn't confidently call customer-visible. These are withheld from the weekly digest and normally live in the review queue — verify before telling a customer."
        >
          <input
            type="checkbox"
            checked={includeNeedsReview}
            onChange={(e) => setIncludeNeedsReview(e.currentTarget.checked)}
            className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
          />
          Include unconfirmed
        </label>

        {data ? (
          <span className="ml-auto text-[11px] text-muted">
            {data.count} ticket{data.count === 1 ? "" : "s"} ·{" "}
            {data.in_scope_pairs} customer conversation
            {data.in_scope_pairs === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-muted italic">Loading shipped requests…</p>
      ) : error ? (
        <div className="text-sm bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-3 text-red-800 dark:text-red-300">
          Failed to load: {error}
        </div>
      ) : !data || data.groups.length === 0 ? (
        <p className="text-sm text-muted italic">
          Nothing shipped in this window. Try widening the date range or
          turning on &ldquo;All accounts&rdquo;.
        </p>
      ) : (
        <div className="space-y-3">
          {data.groups.map((group) => (
            <GroupCard
              key={group.linear_issue_id}
              group={group}
              customersByWorkspace={customersByWorkspace}
              onDraft={(customer) => {
                setDrafting({ group, customer });
                void fetch("/api/enterprise-requests/notify", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    workspace_id: customer.workspace_id,
                    linear_issue_id: group.linear_issue_id,
                    action: "drafted",
                  }),
                });
              }}
              onToggleNotified={(customer, next) =>
                void markNotified(group, customer, next)
              }
            />
          ))}
        </div>
      )}

      {drafting && customersByWorkspace[drafting.customer.workspace_id] ? (
        <OutreachModal
          customer={customersByWorkspace[drafting.customer.workspace_id]}
          initialScenario="feature-shipped"
          feature={{
            title: drafting.group.title,
            description: null,
            ship_url: drafting.group.ship_url ?? drafting.group.url,
            ship_date: drafting.group.ship_date
              ? fmtDate(drafting.group.ship_date)
              : drafting.group.promoted_at
                ? fmtDate(drafting.group.promoted_at)
                : null,
            beta_caveat:
              drafting.group.derived_state === "Live, possibly in beta"
                ? "This is currently in beta rollout — happy to share more if you'd like early access."
                : "",
          }}
          onDraftLifecycle={(state) => {
            if (state === "drafted" || state === "sent") {
              const stash = drafting;
              void fetch("/api/enterprise-requests/notify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  workspace_id: stash.customer.workspace_id,
                  linear_issue_id: stash.group.linear_issue_id,
                  action: "notified",
                }),
              }).then(() =>
                patchNotified(
                  stash.group.linear_issue_id,
                  stash.customer.workspace_id,
                  {
                    ...stash.customer.notified,
                    notified_at: new Date().toISOString(),
                  }
                )
              );
            }
          }}
          onClose={() => setDrafting(null)}
        />
      ) : null}
    </div>
  );
}

function GroupCard({
  group,
  customersByWorkspace,
  onDraft,
  onToggleNotified,
}: {
  group: TicketGroup;
  customersByWorkspace: Record<string, Customer>;
  onDraft: (customer: GroupCustomer) => void;
  onToggleNotified: (customer: GroupCustomer, next: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={group.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-blue-700 dark:text-blue-300 hover:underline break-words"
          >
            {group.linear_identifier}: {group.title}
          </a>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
            <span>Shipped {fmtDate(group.ship_date ?? group.promoted_at)}</span>
            {group.work_type ? <span>· {group.work_type}</span> : null}
            {group.derived_state === "Live, possibly in beta" ? (
              <span className="rounded border border-amber-400 bg-amber-50 dark:bg-amber-500/10 px-1 py-0.5 text-amber-800 dark:text-amber-200 text-[9px] font-semibold">
                POSSIBLY IN BETA
              </span>
            ) : null}
            {group.promotion_confidence !== "confirmed" ? (
              <span
                className="rounded border border-red-400 bg-red-50 dark:bg-red-500/10 px-1 py-0.5 text-red-800 dark:text-red-200 text-[9px] font-semibold"
                title="Not confirmed customer-visible — withheld from the weekly digest. Verify before telling a customer."
              >
                UNCONFIRMED
              </span>
            ) : null}
            {group.ship_url ? (
              <a
                href={group.ship_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                ↗ ship link
              </a>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-muted">
          <div>
            {group.customer_count} customer
            {group.customer_count === 1 ? "" : "s"}
          </div>
          {group.total_arr > 0 ? (
            <div className="tabular-nums">{fmtCurrency(group.total_arr)} ARR</div>
          ) : null}
        </div>
      </div>

      <ul className="mt-2 space-y-1">
        {group.customers.map((c) => {
          const name =
            customersByWorkspace[c.workspace_id]?.company_name ??
            c.company_name ??
            c.workspace_name ??
            c.workspace_id;
          const canDraft =
            c.in_scope && Boolean(customersByWorkspace[c.workspace_id]);
          return (
            <li
              key={c.workspace_id}
              className={`rounded border border-border px-2 py-1.5 text-xs ${
                c.in_scope ? "" : "opacity-60"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-fg">{name}</span>
                  {c.customer_impact ? (
                    <span className="ml-1.5 text-[10px] text-muted">
                      {c.customer_impact}
                    </span>
                  ) : null}
                  {!c.in_scope && c.csm_handle ? (
                    <span className="ml-1.5 text-[10px] text-muted italic">
                      · {c.csm_handle.replace(/_/g, " ")}
                    </span>
                  ) : null}
                </div>
                {c.in_scope ? (
                  <div className="flex items-center gap-2">
                    {canDraft ? (
                      <button
                        type="button"
                        onClick={() => onDraft(c)}
                        className="px-2 py-0.5 text-[11px] rounded border border-border-strong hover:bg-canvas"
                      >
                        ✉ Draft outreach
                      </button>
                    ) : null}
                    <label className="inline-flex items-center gap-1 text-[11px] text-fg cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={!!c.notified.notified_at}
                        onChange={(e) =>
                          onToggleNotified(c, e.currentTarget.checked)
                        }
                        className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                      />
                      Notified
                      {c.notified.notified_at ? (
                        <span className="text-muted">
                          · {fmtDate(c.notified.notified_at)}
                        </span>
                      ) : null}
                    </label>
                  </div>
                ) : (
                  <span className="text-[10px] text-muted italic">
                    other book
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
