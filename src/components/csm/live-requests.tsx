"use client";

import { useEffect, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtDate, fmtCurrency } from "../format";
import { CsmSelector } from "../csm-selector";
import { OutreachModal } from "../outreach-modal";
import {
  ConfidenceExplainer,
  confidenceBasis,
} from "../enterprise-requests/confidence-copy";
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
  linear_state_name: string;
  linear_state_type: string;
  work_type: WorkTypeLabel | null;
  promotion_source: PromotionSource | null;
  promotion_confidence: PromotionConfidence;
  devs_shipped_match: boolean;
  devs_shipped_url: string | null;
  devs_shipped_at: string | null;
  needs_review_reason: NeedsReviewReason | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  ship_url: string | null;
  ship_date: string | null;
  promoted_at: string | null;
  last_engaged_at: string | null;
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

const ALL_STATES = [
  "Triage",
  "Backlog",
  "Todo",
  "In progress",
  "Done (live in app)",
  "Canceled",
  "Duplicate",
] as const;

interface Props {
  /** "shipped" — the outreach queue: rows Linear marks live in the
   *  app, inside a recency window. "all" — the book's whole request
   *  inventory in every state. Same grouping either way; the mode
   *  changes which rows the API returns and which controls make sense
   *  to show. */
  mode?: "shipped" | "all";
  /** CSM handle (or email) to scope to, already resolved server-side
   *  by `resolveCsmFilter`. `null` means the page resolved to "all
   *  CSMs" — either because `?csm=all` is set, or because the viewer
   *  isn't in the book at all. */
  csmParam: string | null;
  /** Every CSM handle in the book, for the scope dropdown. */
  csms: string[];
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

export function LiveRequests({
  mode = "shipped",
  csmParam,
  csms,
  customersByWorkspace,
}: Props) {
  const isAll = mode === "all";
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState(mode === "all" ? "all" : "30d");
  const [states, setStates] = useState<string[]>([]);
  const [showNotified, setShowNotified] = useState(false);
  // Opt-in narrowing: "show me only the ones a release post confirms".
  // Off by default — the tab shows everything Linear calls live.
  const [shipMatchedOnly, setShipMatchedOnly] = useState(false);
  const [drafting, setDrafting] = useState<{
    group: TicketGroup;
    customer: GroupCustomer;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    // `csmParam` is null when the page resolved to "all CSMs". Send
    // the explicit sentinel rather than an empty string: the API
    // treats a blank `csm` as "fall back to the viewer", which would
    // silently re-scope the view to your own book the moment someone
    // picked All CSMs.
    qs.set("csm", csmParam ?? "all");
    qs.set("window", windowKey);
    if (isAll) qs.set("mode", "all");
    if (isAll && states.length > 0) qs.set("states", states.join(","));
    if (showNotified) qs.set("include_notified", "1");
    if (shipMatchedOnly) qs.set("confidence", "confirmed");
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
  }, [csmParam, windowKey, showNotified, shipMatchedOnly, isAll, states]);

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
        {isAll ? (
          <>
            Every feature request logged against your book, grouped by
            Linear ticket so you can see each customer who asked for it.
            States mirror Linear&rsquo;s own —{" "}
            <strong>Done (live in app)</strong> is the delivered bucket,
            and each row there also says whether a{" "}
            <code className="font-mono">#devs-shipped</code> release post
            was matched to the ticket.
          </>
        ) : (
          <>
            Requests Linear marks <strong>Done (live in app)</strong>,
            grouped by ticket so you can see every customer who asked
            for it. Draft a note to close the loop, then check Notified
            so the row drops off the weekly digest. Rows badged{" "}
            <strong>no ship post matched</strong> are worth verifying
            first.
          </>
        )}
      </p>

      <ConfidenceExplainer />

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

        {/* Scope. Replaces an "All accounts" checkbox that could only
            say me-or-everyone, and which silently overrode the page's
            own ?csm= when ticked. The shared selector is what every
            other tab uses, it writes the same URL param, and picking
            "All CSMs" reproduces exactly what the checkbox did. */}
        <label className="inline-flex items-center gap-1.5 text-xs text-fg">
          <span className="text-muted">CSM</span>
          <CsmSelector csms={csms} />
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
          title="Narrow to requests where a #devs-shipped release post carried the Linear ticket, so the code is provably out. Off by default — everything Linear marks live in the app shows here."
        >
          <input
            type="checkbox"
            checked={shipMatchedOnly}
            onChange={(e) => setShipMatchedOnly(e.currentTarget.checked)}
            className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
          />
          Only ship-matched
        </label>

        {isAll ? (
          <div className="flex flex-wrap items-center gap-1.5 w-full">
            <span className="text-[11px] uppercase tracking-wide text-subtle w-14 shrink-0">
              State
            </span>
            {ALL_STATES.map((st) => {
              const on = states.includes(st);
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() =>
                    setStates((prev) =>
                      prev.includes(st)
                        ? prev.filter((v) => v !== st)
                        : [...prev, st]
                    )
                  }
                  className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                    on
                      ? "bg-accent text-accent-fg border-accent"
                      : "bg-surface text-fg border-border-strong hover:bg-canvas"
                  }`}
                >
                  {st}
                </button>
              );
            })}
          </div>
        ) : null}

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
          {isAll ? (
            <>
              No requests match these filters. Try clearing the state
              chips, widening the date range, or switching the CSM to
              &ldquo;All CSMs&rdquo;.
            </>
          ) : (
            <>
              Nothing went live in this window. Try widening the date
              range or switching the CSM to &ldquo;All CSMs&rdquo;.
            </>
          )}
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
            // Reuses the existing `beta_caveat` merge tag so templates
            // don't need rewriting; it now fires on the weaker signal
            // (live per Linear, no release post found).
            beta_caveat: drafting.group.devs_shipped_match
              ? ""
              : "This may still be rolling out — worth confirming before you promise a date.",
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

/** Oldest submission across the customers attached to a ticket — the
 *  "this has been asked since" date, used when a request has no ship
 *  date to show. */
function oldestSubmittedAt(group: TicketGroup): string | null {
  let oldest: string | null = null;
  for (const c of group.customers) {
    const at = c.submitted_at;
    if (!at) continue;
    if (!oldest || at < oldest) oldest = at;
  }
  return oldest;
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
            {/* `all` mode lists requests that have never shipped, so
                the date only renders when there is one — otherwise
                every open request reads "Shipped -". */}
            {group.ship_date || group.promoted_at ? (
              <span>
                Shipped {fmtDate(group.ship_date ?? group.promoted_at)}
              </span>
            ) : (
              <span>Submitted {fmtDate(oldestSubmittedAt(group))}</span>
            )}
            {/* The list sorts by this, so it has to be on screen —
                otherwise an old ticket sitting at the top looks like a
                sorting bug rather than something that was just worked
                on. Suppressed when it matches the date already shown,
                to avoid printing the same day twice. */}
            {group.last_engaged_at &&
            fmtDate(group.last_engaged_at) !==
              fmtDate(
                group.ship_date ?? group.promoted_at ?? oldestSubmittedAt(group)
              ) ? (
              <span
                className="rounded bg-canvas border border-border px-1 py-0.5 text-[9px] text-fg"
                title="Most recent activity on this ticket — a customer attached, a comment added, or the ship. This is what the list is sorted by."
              >
                Last engaged {fmtDate(group.last_engaged_at)}
              </span>
            ) : null}
            {group.work_type ? <span>· {group.work_type}</span> : null}
            <span
              className="rounded bg-canvas border border-border px-1 py-0.5 text-[9px] text-fg"
              title={`Linear state: ${group.linear_state_name}`}
            >
              {group.derived_state}
            </span>
            {/* The ship-corroboration flag. Linear owns the state
                badge above; this one answers the separate question of
                whether a #devs-shipped release post carried the
                ticket. Only meaningful on delivered rows. */}
            {group.derived_state === "Done (live in app)" ? (
              group.devs_shipped_match ? (
                <span
                  className="rounded border border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-1 py-0.5 text-[9px] font-semibold text-emerald-800 dark:text-emerald-200"
                  title={
                    group.devs_shipped_at
                      ? `Matched to a #devs-shipped release post on ${fmtDate(group.devs_shipped_at)}.`
                      : "Matched to a release post in #devs-shipped."
                  }
                >
                  SHIP MATCHED ✓
                </span>
              ) : (
                <span
                  className="rounded border border-slate-400 bg-slate-50 dark:bg-slate-500/10 px-1 py-0.5 text-[9px] font-semibold text-slate-700 dark:text-slate-200"
                  title="Linear says this is live in the app, but no #devs-shipped post carrying the ticket was found. Either the release wasn't parsed or the ticket was closed without the code going out — verify before telling a customer."
                >
                  NO SHIP POST MATCHED
                </span>
              )
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

      {/* The basis line only makes sense on a delivered row — on an
          open request there's nothing to be sure about yet. Amber, not
          red: an unmatched ship is a "double-check this", not an
          error. */}
      {group.derived_state === "Done (live in app)" ? (
        <div
          className={`mt-1.5 text-[10px] leading-snug ${
            group.devs_shipped_match
              ? "text-muted"
              : "text-amber-700 dark:text-amber-300"
          }`}
        >
          {confidenceBasis({
            confidence: group.promotion_confidence,
            source: group.promotion_source,
            work_type: group.work_type,
            needs_review_reason: group.needs_review_reason,
            reviewed_by: group.reviewed_by,
            devsShippedMatch: group.devs_shipped_match,
          })}
        </div>
      ) : null}

      <ul className="mt-2 space-y-1">
        {group.customers.map((c) => {
          const name =
            customersByWorkspace[c.workspace_id]?.company_name ??
            c.company_name ??
            c.workspace_name ??
            c.workspace_id;
          // The outreach template is "your request shipped" — offering
          // it on a request still in Triage (or one that was canceled)
          // hands the CSM a note they can't send. `shipped` mode is
          // all-delivered by construction; `all` mode is not.
          const canDraft =
            c.in_scope &&
            Boolean(customersByWorkspace[c.workspace_id]) &&
            group.derived_state === "Done (live in app)";
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
