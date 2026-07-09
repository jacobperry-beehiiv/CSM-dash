"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { SeverityBadge } from "./status-badge";
import { fmtDate, fmtNumber, fmtPct, fmtRate } from "./format";
import { masqueradeUrl, metabasePubUrl } from "@/lib/links";
import { FilterBar, SearchInput } from "./filters";
import { CsmSelector } from "./csm-selector";
import { BulkEmailLauncher } from "./am/bulk-email-launcher";
import { OutreachModal } from "./outreach-modal";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import type { TemplateScenario } from "@/lib/templates/templates";
import type { Customer, DeliverabilityAlert, RedFlag } from "@/lib/types";
import type { MergeContext } from "@/lib/templates/merge-tags";

/** Build the MergeContext.deliverability sub-object from a flagged
 *  alert. Picks the most severe flag as the headline (critical wins
 *  over warning; if multiple critical, first wins). Used by the
 *  Draft button → OutreachModal handoff so a deliverability-warning
 *  template's tags resolve to real values. */
function buildDeliverabilityCtx(
  alert: DeliverabilityAlert
): NonNullable<MergeContext["deliverability"]> {
  const flag = pickHeadlineFlag(alert.flags);
  return {
    publication_name: alert.post.newsletter,
    send_name: alert.post.subject,
    flagged_metric: flag ? humanizeMetric(flag.metric) : null,
    flagged_value: flag ? formatMetricValue(flag.metric, flag.value) : null,
    benchmark_value: flag ? formatMetricValue(flag.metric, flag.threshold) : null,
    above_or_below: flag
      ? flag.value > flag.threshold
        ? "above"
        : "below"
      : null,
  };
}

function pickHeadlineFlag(flags: RedFlag[]): RedFlag | null {
  if (flags.length === 0) return null;
  return (
    flags.find((f) => f.severity === "critical") ?? flags[0]
  );
}

/** Pick the most-severe alert from a workspace group for the
 *  workspace-row Draft launcher. Critical-flag alerts win over
 *  warning-only; first match within a tier. */
function pickHeadlineAlert(
  alerts: DeliverabilityAlert[]
): DeliverabilityAlert | null {
  if (alerts.length === 0) return null;
  return (
    alerts.find((a) =>
      a.flags.some((f) => f.severity === "critical")
    ) ?? alerts[0]
  );
}

function humanizeMetric(metric: string): string {
  switch (metric) {
    case "delivery_rate":
      return "delivery rate";
    case "open_rate":
      return "open rate";
    case "hard_bounce_rate":
      return "hard bounce rate";
    case "soft_bounce_rate":
      return "soft bounce rate";
    case "unsub_rate":
      return "unsubscribe rate";
    case "spam_rate":
      return "spam complaint rate";
    default:
      return metric.replace(/_/g, " ");
  }
}

/** All flagged metrics are 0–1 ratios. Render as a percentage with
 *  enough decimals to keep small values like spam rate readable —
 *  matches the same auto-precision the QBR charts use. */
function formatMetricValue(metric: string, value: number): string {
  const pct = value * 100;
  const abs = Math.abs(pct);
  const decimals =
    abs === 0 ? 1 : abs < 0.01 ? 4 : abs < 0.1 ? 3 : abs < 1 ? 2 : 1;
  return `${pct.toFixed(decimals)}%`;
}

interface RunResult {
  target_date: string;
  csm_name: string | null;
  total_posts_yesterday: number;
  total_enterprise_posts: number;
  alerts: DeliverabilityAlert[];
  generated_at: string;
  /** ISO timestamp from the underlying deliverability snapshot
   *  (data/deliverability.enc.json). Null when the engine ran off a
   *  live fetch — usually only in local dev pre-sync. Drives the
   *  freshness pill in the header. */
  snapshot_generated_at: string | null;
}

/** Format a snapshot timestamp as a relative-time string + bucket the
 *  severity for the freshness pill. The cron runs at 08/16 UTC daily,
 *  so >24h means a tick was missed; >48h means two ticks were missed
 *  (genuine staleness). */
function snapshotFreshness(iso: string | null): {
  label: string;
  tone: "fresh" | "ok" | "stale" | "very_stale" | "live";
  tooltip: string;
} {
  if (!iso) {
    return {
      label: "live data",
      tone: "live",
      tooltip:
        "No committed snapshot found — engine is running against a live ClickHouse fetch. Typically only happens locally before the first npm run sync.",
    };
  }
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return {
      label: "unknown",
      tone: "stale",
      tooltip: `Unparseable snapshot timestamp: ${iso}`,
    };
  }
  const ageMs = Date.now() - ts;
  const ageH = ageMs / (60 * 60 * 1000);
  let label: string;
  if (ageH < 1) {
    const mins = Math.max(1, Math.round(ageMs / 60_000));
    label = `${mins}m ago`;
  } else if (ageH < 24) {
    label = `${Math.round(ageH)}h ago`;
  } else {
    label = `${Math.floor(ageH / 24)}d ago`;
  }
  const tone: "fresh" | "ok" | "stale" | "very_stale" =
    ageH < 12 ? "fresh" : ageH < 24 ? "ok" : ageH < 48 ? "stale" : "very_stale";
  const tooltip = `Snapshot generated at ${iso}. The sync workflow runs twice daily (08:00 and 16:00 UTC, every day) — if the freshness is amber or red, the most recent run hasn't landed yet or failed.`;
  return { label, tone, tooltip };
}

/** Customer book indexed by workspace_id — powers masquerade links and
 *  the draft-email flow without a second fetch. */
function useCustomerByWorkspace(): Map<string, Customer> {
  const [map, setMap] = useState<Map<string, Customer>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/customers")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Customer[];
      })
      .then((list) => {
        if (cancelled) return;
        const m = new Map<string, Customer>();
        for (const c of list) {
          if (c.workspace_id) m.set(c.workspace_id, c);
        }
        setMap(m);
      })
      .catch(() => {
        // Silent — masquerade / draft actions degrade gracefully.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return map;
}

export function DeliverabilityPanel({
  initial,
  csms,
}: {
  initial: RunResult;
  csms: string[];
}) {
  // Local state mirrors the server's cleared resolutions so a Clear
  // click feels instant. The engine seeded each alert with its
  // cleared field on the server; we shadow that here so optimistic
  // updates don't lose state on re-render.
  const [data, setData] = useState<RunResult>(initial);
  // Posts the user has pending clear/un-clear requests on — used so
  // the button can show a brief "Clearing…" state without going
  // through a full reload.
  const [busyPosts, setBusyPosts] = useState<Set<string>>(new Set());
  const [showCleared, setShowCleared] = useState(false);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    new Set()
  );
  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outreachFor, setOutreachFor] = useState<{
    customer: Customer;
    scenario: TemplateScenario;
    deliverability?: NonNullable<MergeContext["deliverability"]>;
  } | null>(null);
  const [search, setSearch] = useUrlSearch("q");
  const customerByWorkspace = useCustomerByWorkspace();

  // Manual "Sync Slack alerts" — POSTs the same sweep the weekday cron
  // hits. Idempotent per post_id, so a manual click between cron ticks
  // just no-ops on already-pinged sends. Session auth (no bearer needed).
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  async function syncSlackSweep() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const r = await fetch("/api/deliverability/sweep", { method: "POST" });
      const j = (await r.json()) as {
        messages_sent?: number;
        messages_failed?: number;
        disabled?: boolean;
        reason?: string;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (j.disabled) {
        setSyncMessage(
          `Skipped — ${j.reason ?? "deliverability sweep is disabled"}. Configure at /settings/slack.`
        );
      } else {
        const sent = j.messages_sent ?? 0;
        const failed = j.messages_failed ?? 0;
        setSyncMessage(
          sent === 0 && failed === 0
            ? "No new alerts to post — Slack is already up to date."
            : `Posted ${sent} new alert${sent === 1 ? "" : "s"} to Slack${
                failed > 0 ? ` (${failed} failed)` : ""
              }.`
        );
      }
    } catch (e) {
      setSyncMessage(
        `Sync failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setSyncing(false);
    }
  }

  // Manual "Refresh data" — fires the deliverability-data-sync GH
  // workflow via /api/sync/deliverability. The workflow re-pulls the
  // ClickHouse snapshot, commits it, and Vercel auto-redeploys with the
  // fresh data (~90s end-to-end). Button stays disabled until the
  // dispatch returns so a CSM can't queue dozens.
  const [refreshing, setRefreshing] = useState(false);
  async function refreshSnapshot() {
    setRefreshing(true);
    setSyncMessage(null);
    try {
      const r = await fetch("/api/sync/deliverability", { method: "POST" });
      const j = (await r.json()) as {
        message?: string;
        actions_url?: string;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSyncMessage(
        j.message ??
          "Refresh started. Fresh data should be live in ~90 seconds."
      );
    } catch (e) {
      setSyncMessage(
        `Refresh failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function setClearedOptimistic(
    postId: string,
    cleared: boolean,
    reason?: string
  ) {
    setBusyPosts((prev) => {
      const next = new Set(prev);
      next.add(postId);
      return next;
    });
    // Optimistic patch.
    const stamp = new Date().toISOString();
    setData((prev) => ({
      ...prev,
      alerts: prev.alerts.map((a) =>
        a.post.post_id !== postId
          ? a
          : {
              ...a,
              cleared: cleared
                ? {
                    cleared_at: stamp,
                    cleared_by: null,
                    reason: reason ?? null,
                  }
                : null,
            }
      ),
    }));
    try {
      const r = await fetch("/api/deliverability/clear", {
        method: cleared ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: postId, reason }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      // Roll back on failure.
      setData((prev) => ({
        ...prev,
        alerts: prev.alerts.map((a) =>
          a.post.post_id !== postId
            ? a
            : { ...a, cleared: cleared ? null : a.cleared }
        ),
      }));
      window.alert(
        `Clear failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setBusyPosts((prev) => {
        const next = new Set(prev);
        next.delete(postId);
        return next;
      });
    }
  }

  function toggleWorkspace(key: string) {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function togglePost(postId: string) {
    setExpandedPosts((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }

  /** Search filters by workspace name / subject — same shape as the
   *  other tabs so the filter strip stays consistent. Also matches the
   *  publication_id + organization_id carried on each post + the CSM
   *  attribution, so a paste-an-ID workflow works here too. */
  const alerts = useMemo(() => {
    if (!search) return data.alerts;
    const q = search.toLowerCase();
    // Beehiiv's customer-facing publication IDs carry a `pub_` prefix
    // (admin URLs, public API) but PostMetricsRow.publication_id is
    // the raw UUID. Strip the prefix off the query so either form
    // matches without the user needing to know which one we store.
    const qNoPubPrefix = q.startsWith("pub_") ? q.slice(4) : q;
    return data.alerts.filter((a) => {
      const csmRaw = a.csm ?? null;
      const csmHuman = csmRaw?.replace(/_/g, " ") ?? null;
      const pubId = a.post.publication_id.toLowerCase();
      return (
        a.post.workspace_name.toLowerCase().includes(q) ||
        a.post.subject.toLowerCase().includes(q) ||
        pubId.includes(q) ||
        pubId.includes(qNoPubPrefix) ||
        a.post.organization_id?.toLowerCase().includes(q) ||
        a.post.newsletter?.toLowerCase().includes(q) ||
        csmRaw?.toLowerCase().includes(q) ||
        csmHuman?.toLowerCase().includes(q)
      );
    });
  }, [data.alerts, search]);

  const clearedCount = useMemo(
    () => data.alerts.filter((a) => a.cleared).length,
    [data.alerts]
  );

  // Hide cleared sends from the default view; the toggle exposes them
  // with the "Cleared" pill + an undo button.
  const visibleAlerts = useMemo(
    () => alerts.filter((a) => showCleared || !a.cleared),
    [alerts, showCleared]
  );

  const workspaceGroups = useMemo(
    () => groupAlertsByWorkspace(visibleAlerts),
    [visibleAlerts]
  );

  const allPostIds = useMemo(
    () => visibleAlerts.map((a) => a.post.post_id),
    [visibleAlerts]
  );

  const selectedCustomers = useMemo(() => {
    const seen = new Set<string>();
    const out: Customer[] = [];
    for (const a of visibleAlerts) {
      if (!selected.has(a.post.post_id)) continue;
      const ws = a.post.organization_id;
      if (!ws || seen.has(ws)) continue;
      seen.add(ws);
      const c = customerByWorkspace.get(ws);
      if (c) out.push(c);
    }
    return out;
  }, [visibleAlerts, selected, customerByWorkspace]);

  function toggleWorkspaceSelected(postIds: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = postIds.every((id) => next.has(id));
      if (allSelected) {
        for (const id of postIds) next.delete(id);
      } else {
        for (const id of postIds) next.add(id);
      }
      return next;
    });
  }

  function toggleSelected(postId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((prev) =>
      prev.size === allPostIds.length ? new Set() : new Set(allPostIds)
    );
  }

  return (
    <div className="space-y-4">
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search workspace, subject, CSM, publication ID…"
        />
        <CsmSelector csms={csms} />
        {clearedCount > 0 ? (
          <label className="inline-flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={showCleared}
              onChange={(e) => setShowCleared(e.target.checked)}
              className="rounded border-border-strong"
            />
            <span>
              Show cleared ({clearedCount})
            </span>
          </label>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={refreshSnapshot}
          disabled={refreshing}
          className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas disabled:opacity-50"
          title="Kick the deliverability-data-sync GitHub Action to re-pull the ClickHouse snapshot now. Fresh data lands after Vercel redeploys (~90 seconds)."
        >
          {refreshing ? "Refreshing…" : "Refresh data"}
        </button>
        <button
          type="button"
          onClick={syncSlackSweep}
          disabled={syncing}
          className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas disabled:opacity-50"
          title="Post any new critical deliverability alerts to Slack now (same as the daily 09:15 UTC cron). Idempotent per send."
        >
          {syncing ? "Syncing…" : "Sync Slack alerts"}
        </button>
      </FilterBar>
      {syncMessage ? (
        <div className="text-xs text-muted">{syncMessage}</div>
      ) : null}
      <div className="text-xs text-muted">
        {(() => {
          const flaggedAll = data.alerts.filter(
            (a) => a.flags.length > 0 && !a.cleared
          ).length;
          const flaggedFiltered = visibleAlerts.filter(
            (a) => a.flags.length > 0 && !a.cleared
          ).length;
          const carryoverCount = data.alerts.filter(
            (a) => !a.cleared && a.post.sent_date !== data.target_date
          ).length;
          if (search) {
            return (
              <>
                <strong className="text-fg">{visibleAlerts.length}</strong> of{" "}
                {data.alerts.length} sends match the filter (
                {flaggedFiltered} active alerts)
              </>
            );
          }
          return (
            <>
              <strong className="text-fg">{visibleAlerts.length}</strong>{" "}
              {showCleared || clearedCount === 0 ? "sends" : "active sends"}
              {" · "}
              <strong className="text-fg">{workspaceGroups.length}</strong>{" "}
              workspace{workspaceGroups.length === 1 ? "" : "s"}
              {" · "}
              {flaggedAll} active alerts
              {carryoverCount > 0 ? (
                <>
                  {" · "}
                  <span
                    className="text-purple-700 dark:text-purple-300"
                    title="Uncleared critical sends from earlier dates that carry forward across data refreshes until a CSM clears them. Filter or browse the table to see them inline (purple Carryover pill)."
                  >
                    {carryoverCount} carried over
                  </span>
                </>
              ) : null}
              {clearedCount > 0 && !showCleared ? (
                <> · {clearedCount} cleared (hidden)</>
              ) : null}
            </>
          );
        })()}
        {" · "}
        {data.target_date} · generated {fmtDate(data.generated_at)}
        {" · "}
        {(() => {
          const f = snapshotFreshness(data.snapshot_generated_at);
          const cls =
            f.tone === "fresh"
              ? "text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10"
              : f.tone === "ok"
                ? "text-muted border-border bg-canvas/40"
                : f.tone === "stale"
                  ? "text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
                  : f.tone === "very_stale"
                    ? "text-red-800 dark:text-red-200 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10"
                    : "text-muted border-border bg-canvas/40";
          return (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded border ${cls}`}
              title={f.tooltip}
            >
              snapshot {f.label}
            </span>
          );
        })()}
      </div>

      {visibleAlerts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-canvas border border-border rounded-md">
          <span className="text-xs text-muted">
            <strong>{selected.size}</strong> selected of {allPostIds.length}
          </span>
          <button
            type="button"
            onClick={selectAllVisible}
            className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
          >
            {selected.size === allPostIds.length ? "Deselect all" : "Select all"}
          </button>
          <div className="flex-1" />
          <BulkEmailLauncher
            customers={selectedCustomers}
            defaultTemplateId="general-checkin"
            disabled={selected.size === 0 || selectedCustomers.length === 0}
            label={
              selectedCustomers.length > 0
                ? `📥 Draft for ${selectedCustomers.length}`
                : "📥 Draft selected"
            }
            trackingIdFor={(c) => c.workspace_id ?? null}
            auditLabel="Deliverability outreach email sent"
          />
        </div>
      ) : null}

      {visibleAlerts.length === 0 ? (
        <div className="bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-lg p-4 text-sm text-green-800 dark:text-green-200">
          {search ? (
            <>No sends match &ldquo;{search}&rdquo;.</>
          ) : data.total_posts_yesterday === 0 ? (
            <>No publications in this book sent on {data.target_date}.</>
          ) : clearedCount > 0 && !showCleared ? (
            <>
              No active sends — all {clearedCount} of yesterday&apos;s sends
              have been cleared.
            </>
          ) : (
            <>
              No sends on {data.target_date} for the selected scope.
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface shadow-card overflow-x-auto">
          <table className="w-full text-sm">
            <colgroup>
              <col className="w-8" />
              <col className="w-8" />
              <col className="w-[8%]" />
              <col className="w-[16%]" />
              <col className="w-[20%] hidden md:table-cell" />
              <col className="w-[7%]" />
              <col className="w-[6%]" />
              <col className="w-[6%]" />
              <col className="w-[6%] hidden xl:table-cell" />
              <col className="w-[6%] hidden xl:table-cell" />
              <col className="w-[6%] hidden xl:table-cell" />
              <col className="w-[9%] hidden lg:table-cell" />
              <col className="w-[7%]" />
            </colgroup>
            <thead className="bg-canvas">
              <tr className="text-left border-b border-border">
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3"></th>
                <th className="px-3 py-3 font-medium text-muted">Status</th>
                <th className="px-3 py-3 font-medium text-muted">Workspace</th>
                <th className="px-3 py-3 font-medium text-muted hidden md:table-cell">
                  Subject
                </th>
                <th className="px-3 py-3 font-medium text-muted text-right">
                  Sent
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right"
                  title="Delivery rate (delivered / sent)"
                >
                  Deliv
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right"
                  title="Open rate (opens / delivered)"
                >
                  Open
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right hidden xl:table-cell"
                  title="Click-through rate (clicks / delivered)"
                >
                  CTR
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right hidden xl:table-cell"
                  title="Spam complaint rate"
                >
                  Spam
                </th>
                <th
                  className="px-3 py-3 font-medium text-muted text-right hidden xl:table-cell"
                  title="Unsubscribe rate — flagged when audience fatigue is likely."
                >
                  Unsub
                </th>
                <th className="px-3 py-3 font-medium text-muted hidden lg:table-cell">
                  CSM
                </th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {workspaceGroups.map((group) => {
                const postIds = group.alerts.map((a) => a.post.post_id);
                const selectedInGroup = postIds.filter((id) =>
                  selected.has(id)
                ).length;
                const allInGroupSelected =
                  postIds.length > 0 && selectedInGroup === postIds.length;
                const someInGroupSelected =
                  selectedInGroup > 0 && !allInGroupSelected;
                const isWorkspaceOpen = expandedWorkspaces.has(
                  group.workspaceId
                );
                const status = summarizeWorkspaceAlerts(group.alerts);
                const metrics = aggregateWorkspaceMetrics(group.alerts);
                const customer = customerByWorkspace.get(group.workspaceId);
                const masqUrl = customer?.owner_email
                  ? masqueradeUrl(customer.owner_email)
                  : null;
                const carryoverCount = group.alerts.filter(
                  (a) =>
                    !a.cleared && a.post.sent_date !== data.target_date
                ).length;

                return (
                  <Fragment key={group.workspaceId}>
                    <tr
                      onClick={() => toggleWorkspace(group.workspaceId)}
                      className={`border-b border-border align-top cursor-pointer transition-colors ${
                        isWorkspaceOpen
                          ? status.flagged
                            ? status.critical
                              ? "bg-red-50 dark:bg-red-500/60"
                              : "bg-amber-50 dark:bg-amber-500/60"
                            : "bg-blue-50 dark:bg-blue-500/30"
                          : "hover:bg-blue-50 dark:hover:bg-blue-500/15"
                      }`}
                    >
                      <td
                        className="px-3 py-3 text-subtle select-none"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={allInGroupSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someInGroupSelected;
                          }}
                          onChange={() => toggleWorkspaceSelected(postIds)}
                          aria-label={`Select all sends for ${group.workspaceName}`}
                          className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-3 text-subtle select-none">
                        <span
                          className={`inline-block transition-transform ${
                            isWorkspaceOpen ? "rotate-90" : ""
                          }`}
                        >
                          ▸
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col items-start gap-1">
                          {status.clearedOnly ? (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-slate-200 text-slate-700 dark:bg-slate-500/30 dark:text-slate-200"
                              title="Every send in this workspace has been cleared"
                            >
                              Cleared
                            </span>
                          ) : status.flagged ? (
                            <SeverityBadge
                              severity={status.critical ? "critical" : "warning"}
                            />
                          ) : (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200"
                              title="No deliverability thresholds tripped"
                            >
                              Clean
                            </span>
                          )}
                          {status.activeAlertCount > 1 ? (
                            <span className="text-[10px] text-muted">
                              {status.activeAlertCount} flagged
                            </span>
                          ) : null}
                          {carryoverCount > 0 ? (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200"
                              title="One or more critical sends from earlier dates carried forward until cleared."
                            >
                              {carryoverCount} carryover
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 break-words">
                        <div className="font-semibold text-fg">
                          {group.workspaceName}
                        </div>
                        <div className="text-xs text-muted">
                          {group.alerts.length} publication
                          {group.alerts.length === 1 ? "" : "s"}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted hidden md:table-cell break-words">
                        {status.activeAlertCount > 0 ? (
                          <span>
                            {status.activeAlertCount} active alert
                            {status.activeAlertCount === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span className="text-subtle italic">
                            Expand for publication details
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {fmtNumber(metrics.totalSent)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <span
                          className={metricSeverityClass(
                            groupMetricSeverity(group.alerts, "delivery_rate")
                          )}
                        >
                          {fmtPct(metrics.minDelivery * 100, 1)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <span
                          className={metricSeverityClass(
                            groupMetricSeverity(group.alerts, "open_rate")
                          )}
                        >
                          {fmtPct(metrics.minOpen * 100, 1)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums hidden xl:table-cell">
                        <span
                          className={metricSeverityClass(
                            groupMetricSeverity(group.alerts, "ctr")
                          )}
                        >
                          {fmtPct(metrics.maxCtr * 100, 1)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums hidden xl:table-cell">
                        <span
                          className={metricSeverityClass(
                            groupMetricSeverity(group.alerts, "spam_rate")
                          )}
                        >
                          {fmtRate(metrics.maxSpam, 3)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums hidden xl:table-cell">
                        <span
                          className={metricSeverityClass(
                            groupMetricSeverity(group.alerts, "unsub_rate")
                          )}
                        >
                          {fmtPct(metrics.maxUnsub * 100, 2)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-muted hidden lg:table-cell break-words">
                        {group.csm?.replace(/_/g, " ") ?? (
                          <span className="text-subtle italic">unassigned</span>
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
                              className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                            >
                              Masq
                            </a>
                          ) : null}
                          {customer ? (
                            <button
                              type="button"
                              onClick={() => {
                                // Workspace-level Draft picks the
                                // headline alert from the group so
                                // the deliverability merge tags
                                // resolve against the worst send.
                                const headline = pickHeadlineAlert(
                                  group.alerts
                                );
                                setOutreachFor({
                                  customer,
                                  scenario: "general-checkin",
                                  deliverability: headline
                                    ? buildDeliverabilityCtx(headline)
                                    : undefined,
                                });
                              }}
                              title="Draft outreach email (template picker + Gmail draft)"
                              className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                            >
                              Draft
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {isWorkspaceOpen ? (
                      <tr className="border-b border-border bg-canvas/30">
                        <td colSpan={13} className="px-3 py-2 pl-16 pr-4">
                          <div className="ml-4 rounded-lg border border-border bg-surface shadow-sm overflow-hidden">
                            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted bg-canvas/60 border-b border-border/60">
                              Publications ({group.alerts.length})
                            </div>
                            <table className="w-full text-xs">
                              {/* Column widths mirror the publication row
                               *  <td>s below so the header labels sit
                               *  directly over their values. Kept here
                               *  (rather than the outer <colgroup>) so
                               *  the inner grid stays independent of
                               *  the workspace-row layout — those two
                               *  used to share widths and drifted out
                               *  of alignment as columns were added. */}
                              <colgroup>
                                <col className="w-8" />
                                <col className="w-8" />
                                <col className="w-[8%]" />
                                <col className="w-[16%]" />
                                <col className="w-[22%] hidden md:table-cell" />
                                <col className="w-[7%]" />
                                <col className="w-[6%]" />
                                <col className="w-[6%]" />
                                <col className="w-[6%] hidden xl:table-cell" />
                                <col className="w-[6%] hidden xl:table-cell" />
                                <col className="w-[6%] hidden xl:table-cell" />
                                <col className="w-[9%] hidden lg:table-cell" />
                                <col className="w-[7%]" />
                              </colgroup>
                              <thead className="bg-canvas/40 text-[10px] uppercase tracking-wider text-subtle">
                                <tr>
                                  <th className="px-2 py-1.5"></th>
                                  <th className="px-2 py-1.5"></th>
                                  <th className="px-2 py-1.5 text-left font-semibold">
                                    Status
                                  </th>
                                  <th className="px-2 py-1.5 text-left font-semibold pl-5">
                                    Publication
                                  </th>
                                  <th className="px-2 py-1.5 text-left font-semibold hidden md:table-cell">
                                    Subject
                                  </th>
                                  <th className="px-2 py-1.5 text-right font-semibold">
                                    Sent
                                  </th>
                                  <th className="px-2 py-1.5 text-right font-semibold">
                                    Deliv
                                  </th>
                                  <th className="px-2 py-1.5 text-right font-semibold">
                                    Open
                                  </th>
                                  <th className="px-2 py-1.5 text-right font-semibold hidden xl:table-cell">
                                    CTR
                                  </th>
                                  <th className="px-2 py-1.5 text-right font-semibold hidden xl:table-cell">
                                    Spam
                                  </th>
                                  <th className="px-2 py-1.5 text-right font-semibold hidden xl:table-cell">
                                    Unsub
                                  </th>
                                  <th className="px-2 py-1.5 hidden lg:table-cell"></th>
                                  <th className="px-2 py-1.5 text-right font-semibold">
                                    Actions
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.alerts.map((alert) => (
                                  <PublicationAlertRows
                                    key={alert.post.post_id}
                                    alert={alert}
                                    targetDate={data.target_date}
                                    selected={selected.has(alert.post.post_id)}
                                    expanded={expandedPosts.has(
                                      alert.post.post_id
                                    )}
                                    busy={busyPosts.has(alert.post.post_id)}
                                    onToggleSelected={() =>
                                      toggleSelected(alert.post.post_id)
                                    }
                                    onToggleExpanded={() =>
                                      togglePost(alert.post.post_id)
                                    }
                                    onClear={(cleared, reason) =>
                                      void setClearedOptimistic(
                                        alert.post.post_id,
                                        cleared,
                                        reason
                                      )
                                    }
                                    onDraft={
                                      customer
                                        ? () =>
                                            setOutreachFor({
                                              customer,
                                              scenario: "general-checkin",
                                              deliverability:
                                                buildDeliverabilityCtx(alert),
                                            })
                                        : undefined
                                    }
                                  />
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-subtle">
        Sends are grouped by workspace — expand a row to see individual
        publications. Select a workspace checkbox to bulk-select all its
        sends, or use <strong>Draft</strong> on the workspace row.
      </p>

      {outreachFor ? (
        <OutreachModal
          customer={outreachFor.customer}
          initialScenario={outreachFor.scenario}
          deliverability={outreachFor.deliverability}
          onClose={() => setOutreachFor(null)}
        />
      ) : null}
    </div>
  );
}

interface WorkspaceGroup {
  workspaceId: string;
  workspaceName: string;
  alerts: DeliverabilityAlert[];
  csm: string | null;
}

function workspaceKey(alert: DeliverabilityAlert): string {
  return (
    alert.post.organization_id ||
    alert.post.workspace_name ||
    alert.post.post_id
  );
}

function groupAlertsByWorkspace(alerts: DeliverabilityAlert[]): WorkspaceGroup[] {
  const map = new Map<string, DeliverabilityAlert[]>();
  const order: string[] = [];
  for (const alert of alerts) {
    const key = workspaceKey(alert);
    if (!map.has(key)) order.push(key);
    const list = map.get(key) ?? [];
    list.push(alert);
    map.set(key, list);
  }
  return order.map((workspaceId) => {
    const groupAlerts = map.get(workspaceId)!;
    return {
      workspaceId,
      workspaceName: groupAlerts[0].post.workspace_name,
      alerts: groupAlerts,
      csm: groupAlerts[0].csm,
    };
  });
}

function summarizeWorkspaceAlerts(alerts: DeliverabilityAlert[]) {
  const active = alerts.filter((a) => !a.cleared);
  const flagged = active.filter((a) => a.flags.length > 0);
  const critical = flagged.some((a) =>
    a.flags.some((f) => f.severity === "critical")
  );
  return {
    clearedOnly: active.length === 0 && alerts.length > 0,
    flagged: flagged.length > 0,
    critical,
    activeAlertCount: flagged.length,
  };
}

function aggregateWorkspaceMetrics(alerts: DeliverabilityAlert[]) {
  if (alerts.length === 0) {
    return {
      totalSent: 0,
      minDelivery: 0,
      minOpen: 0,
      maxCtr: 0,
      maxSpam: 0,
      maxUnsub: 0,
    };
  }
  return {
    totalSent: alerts.reduce((sum, a) => sum + a.post.sent, 0),
    minDelivery: Math.min(...alerts.map((a) => a.post.delivery_rate)),
    minOpen: Math.min(...alerts.map((a) => a.post.open_rate)),
    maxCtr: Math.max(...alerts.map((a) => a.post.ctr)),
    maxSpam: Math.max(...alerts.map((a) => a.post.spam_rate)),
    maxUnsub: Math.max(...alerts.map((a) => a.post.unsub_rate)),
  };
}

/** Which severity, if any, is a specific metric flagged at on this
 *  single post? Cleared sends read as "no flag" — we want the cell
 *  to render neutral again once the CSM has acknowledged. */
type MetricKey =
  | "delivery_rate"
  | "open_rate"
  | "ctr"
  | "spam_rate"
  | "unsub_rate"
  | "hard_bounce_rate"
  | "soft_bounce_rate";

function postMetricSeverity(
  alert: DeliverabilityAlert,
  metric: MetricKey
): "critical" | "warning" | null {
  if (alert.cleared) return null;
  let severity: "critical" | "warning" | null = null;
  for (const flag of alert.flags) {
    if (flag.metric !== metric) continue;
    if (flag.severity === "critical") return "critical";
    severity = "warning";
  }
  return severity;
}

/** Roll postMetricSeverity across every alert in a workspace group.
 *  Used to color the aggregate value on the workspace header row —
 *  if ANY publication in the group tripped this metric, the aggregate
 *  cell picks up the highest severity found. */
function groupMetricSeverity(
  alerts: DeliverabilityAlert[],
  metric: MetricKey
): "critical" | "warning" | null {
  let seen: "critical" | "warning" | null = null;
  for (const a of alerts) {
    const s = postMetricSeverity(a, metric);
    if (s === "critical") return "critical";
    if (s === "warning") seen = "warning";
  }
  return seen;
}

/** Tailwind classes for a metric-value cell keyed by severity.
 *  `null` returns empty so we don't shift the layout for healthy
 *  cells. Applied to the inline span wrapping the number — the <td>
 *  keeps its `tabular-nums` for column alignment. */
function metricSeverityClass(
  severity: "critical" | "warning" | null
): string {
  if (severity === "critical") {
    return "text-red-700 dark:text-red-300 font-semibold";
  }
  if (severity === "warning") {
    return "text-amber-700 dark:text-amber-300 font-semibold";
  }
  return "";
}

function publicationAccent(
  flagged: boolean,
  critical: boolean,
  cleared: boolean
): string {
  if (cleared) return "border-l-slate-300 dark:border-l-slate-500";
  if (!flagged) return "border-l-emerald-300 dark:border-l-emerald-600";
  return critical
    ? "border-l-red-400 dark:border-l-red-500"
    : "border-l-amber-400 dark:border-l-amber-500";
}

function PublicationAlertRows({
  alert,
  targetDate,
  selected,
  expanded,
  busy,
  onToggleSelected,
  onToggleExpanded,
  onClear,
  onDraft,
}: {
  alert: DeliverabilityAlert;
  targetDate: string;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onClear: (cleared: boolean, reason?: string) => void;
  onDraft?: () => void;
}) {
  const flagged = alert.flags.length > 0;
  const cleared = Boolean(alert.cleared);
  const critical =
    !cleared && alert.flags.some((f) => f.severity === "critical");
  const isCarryover = alert.post.sent_date !== targetDate;
  const mbUrl = metabasePubUrl({
    workspace_id: alert.post.organization_id,
    workspace_name: alert.post.workspace_name,
    publication_id: alert.post.publication_id,
  });
  const accent = publicationAccent(flagged, critical, cleared);

  return (
    <Fragment>
      <tr
        onClick={onToggleExpanded}
        className={`border-b border-border/60 align-top cursor-pointer transition-colors text-xs bg-surface hover:bg-canvas/70 border-l-[3px] ${accent} ${
          expanded ? "bg-canvas/50" : ""
        }`}
      >
        <td
          className="px-2 py-2 text-subtle select-none w-8"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`Select ${alert.post.newsletter}`}
            className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
          />
        </td>
        <td className="px-2 py-2 text-subtle select-none w-8">
          <span
            className={`inline-block transition-transform text-[10px] ${
              expanded ? "rotate-90" : ""
            }`}
          >
            ▸
          </span>
        </td>
        <td className="px-2 py-2 w-[8%]">
          <div className="flex flex-col items-start gap-1">
            {cleared ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-slate-200 text-slate-700 dark:bg-slate-500/30 dark:text-slate-200">
                Cleared
              </span>
            ) : flagged ? (
              <SeverityBadge severity={critical ? "critical" : "warning"} />
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200">
                Clean
              </span>
            )}
            {isCarryover && !cleared ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200">
                Carryover
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-2 py-2 break-words w-[18%] pl-5">
          <div className="text-fg">{alert.post.newsletter}</div>
          {isCarryover ? (
            <div className="text-[10px] text-subtle mt-0.5">
              Sent {fmtDate(alert.post.sent_date)}
            </div>
          ) : null}
        </td>
        <td className="px-2 py-2 text-muted italic break-words hidden md:table-cell w-[22%]">
          &ldquo;{alert.post.subject}&rdquo;
        </td>
        <td className="px-2 py-2 text-right tabular-nums w-[7%]">
          {fmtNumber(alert.post.sent)}
        </td>
        <td className="px-2 py-2 text-right tabular-nums w-[6%]">
          <span
            className={metricSeverityClass(
              postMetricSeverity(alert, "delivery_rate")
            )}
          >
            {fmtPct(alert.post.delivery_rate * 100, 1)}
          </span>
        </td>
        <td className="px-2 py-2 text-right tabular-nums w-[6%]">
          <span
            className={metricSeverityClass(
              postMetricSeverity(alert, "open_rate")
            )}
          >
            {fmtPct(alert.post.open_rate * 100, 1)}
          </span>
        </td>
        <td className="px-2 py-2 text-right tabular-nums hidden xl:table-cell w-[6%]">
          <span
            className={metricSeverityClass(postMetricSeverity(alert, "ctr"))}
          >
            {fmtPct(alert.post.ctr * 100, 1)}
          </span>
        </td>
        <td className="px-2 py-2 text-right tabular-nums hidden xl:table-cell w-[6%]">
          <span
            className={metricSeverityClass(
              postMetricSeverity(alert, "spam_rate")
            )}
          >
            {fmtRate(alert.post.spam_rate, 3)}
          </span>
        </td>
        <td className="px-2 py-2 text-right tabular-nums hidden xl:table-cell w-[6%]">
          <span
            className={metricSeverityClass(
              postMetricSeverity(alert, "unsub_rate")
            )}
          >
            {fmtPct(alert.post.unsub_rate * 100, 2)}
          </span>
        </td>
        <td className="px-2 py-2 hidden lg:table-cell w-[9%]" />
        <td className="px-2 py-2 w-[7%]" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1 justify-end">
            {mbUrl ? (
              <a
                href={mbUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open Metabase dashboard for this publication"
                aria-label="Open Metabase"
                className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
              >
                📊
              </a>
            ) : null}
            {onDraft ? (
              <button
                type="button"
                onClick={onDraft}
                title="Draft outreach email"
                className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
              >
                Draft
              </button>
            ) : null}
            {flagged ? (
              cleared ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onClear(false)}
                  title="Restore this send to the active alerts list."
                  aria-label="Undo clear"
                  className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas disabled:opacity-50"
                >
                  {busy ? "…" : "Undo"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const reason =
                      window.prompt(
                        "Optional reason for clearing this send (visible to the team). Leave blank to skip."
                      ) ?? "";
                    onClear(true, reason || undefined);
                  }}
                  title="Acknowledge this flagged send and hide it from the active alerts list."
                  aria-label="Clear flagged send"
                  className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas disabled:opacity-50"
                >
                  {busy ? "…" : "Clear"}
                </button>
              )
            ) : null}
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border/60 bg-canvas/40">
          <td colSpan={13} className="px-4 py-3 pl-8 border-l-[3px] border-l-border/80">
            <DeliverabilityDetail alert={alert} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function DeliverabilityDetail({ alert }: { alert: DeliverabilityAlert }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">
        Sent {fmtDate(alert.post.sent_date)} · {fmtNumber(alert.post.sent)}{" "}
        recipients · {alert.post.newsletter}
      </div>

      {alert.cleared ? (
        <div className="rounded-md border border-slate-300 dark:border-slate-500/30 bg-slate-100 dark:bg-slate-500/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-200">
          Cleared {fmtDate(alert.cleared.cleared_at)}
          {alert.cleared.cleared_by ? <> by {alert.cleared.cleared_by}</> : null}
          {alert.cleared.reason ? (
            <>
              {" · "}
              <span className="italic">&ldquo;{alert.cleared.reason}&rdquo;</span>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 bg-surface rounded-md border border-border p-3">
        <Metric label="Delivered" value={fmtRate(alert.post.delivery_rate)} />
        <Metric label="Open" value={fmtRate(alert.post.open_rate)} />
        <Metric label="Click" value={fmtRate(alert.post.ctr)} />
        <Metric label="Hard bnc" value={fmtRate(alert.post.hard_bounce_rate)} />
        <Metric label="Unsub" value={fmtRate(alert.post.unsub_rate)} />
        <Metric label="Spam" value={fmtRate(alert.post.spam_rate, 3)} />
      </div>

      <div className="bg-surface rounded-md border border-border p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
          Flags ({alert.flags.length})
        </h4>
        {alert.flags.length === 0 ? (
          <p className="text-sm text-muted">
            No thresholds tripped — every deliverability metric is in healthy
            range.
          </p>
        ) : (
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
                <span className="text-fg break-words">{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-medium text-fg">{value}</div>
    </div>
  );
}
