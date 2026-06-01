"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { fmtCurrency, fmtDate, fmtNumber, fmtPct } from "../format";
import { CsmSelector } from "../csm-selector";
import { SelectFilter } from "../filters";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { RowActions } from "../row-actions";
import { OutreachModal } from "../outreach-modal";
import { BucketSection } from "./bucket-section";
import { BulkEmailLauncher } from "./bulk-email-launcher";
import { CustomerDetailPanel } from "../customer-detail-panel";
import type { ProactiveOutreachMap } from "@/lib/data/proactive-outreach";

interface Props {
  rows: Customer[];
  csms: string[];
}

interface Bucket {
  label: string;
  test: (pct: number) => boolean;
  color: string;
}

const BUCKETS: Bucket[] = [
  {
    label: "≥100% — over cap",
    test: (p) => p >= 100,
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
  },
  {
    label: "95–99%",
    test: (p) => p >= 95 && p < 100,
    color: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900",
  },
  {
    label: "90–94%",
    test: (p) => p >= 90 && p < 95,
    color: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900",
  },
  {
    label: "85–89%",
    test: (p) => p >= 85 && p < 90,
    color: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900",
  },
  {
    label: "80–84%",
    test: (p) => p >= 80 && p < 85,
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
  },
  {
    label: "75–79%",
    test: (p) => p >= 75 && p < 80,
    color: "bg-yellow-50 border-yellow-200 text-yellow-900",
  },
];

function pct(c: Customer): number {
  if (c.percent_of_max_subs != null) {
    return c.percent_of_max_subs > 1
      ? c.percent_of_max_subs
      : c.percent_of_max_subs * 100;
  }
  if (c.active_subs != null && c.max_subscriptions) {
    return (c.active_subs / c.max_subscriptions) * 100;
  }
  return 0;
}

function priceLabel(c: Customer): string {
  const interval = (c.interval ?? "").toLowerCase();
  if (interval === "month" || interval === "monthly") {
    return `${fmtCurrency(c.mrr)}/mo`;
  }
  return `${fmtCurrency(c.arr)}/yr`;
}

export function EnterpriseOnlyPanel({ rows, csms }: Props) {
  const [outreachFor, setOutreachFor] = useState<Customer | null>(null);
  // Bulk-select state — keyed on workspace_id (the row's stable id).
  // Mirrors the past-due-panel pattern so all AM tabs feel the same.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per-workspace proactive-outreach lifecycle state (ping_sent_at,
  // last_outreach_at, last_nudge_at). Drives the inline status badge
  // and the "Mark outreach logged" action.
  const [outreachMap, setOutreachMap] = useState<ProactiveOutreachMap>({});
  // Filter rows by whether AM has logged outreach yet — "no outreach"
  // is the actionable bucket; "has outreach" surfaces who's already
  // been pitched.
  const [outreachFilter, setOutreachFilter] = useUrlSearch("outreach");
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepReport, setSweepReport] = useState<string | null>(null);
  // Per-row expand state — matches the /csm CustomerTable pattern so
  // AM users get the same click-row-to-see-full-detail affordance the
  // brief calls out. Keyed by rowKey() so it survives re-renders.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleExpanded(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const reloadOutreach = useCallback(() => {
    fetch("/api/proactive-outreach")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setOutreachMap((j as ProactiveOutreachMap) ?? {}))
      .catch(() => {});
  }, []);

  // Wipe the proactive-outreach entry for a workspace so the 5-day
  // dedupe no longer applies — next sweep / manual ping fires fresh.
  // Used by the inline "× clear" chip next to a row's badge and the
  // bulk "Clear ping status" toolbar button.
  const clearProactive = useCallback(
    async (workspaceIds: string[]) => {
      const ids = workspaceIds.filter(Boolean);
      if (ids.length === 0) return;
      // The DELETE endpoint takes one workspace_id per call. Loop in
      // sequence so a single 5xx doesn't fail the whole batch — each
      // delete is idempotent server-side.
      let cleared = 0;
      for (const id of ids) {
        try {
          const r = await fetch("/api/proactive-outreach", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace_id: id }),
          });
          if (r.ok) cleared++;
        } catch {
          /* non-fatal — continue with the next id */
        }
      }
      reloadOutreach();
      return cleared;
    },
    [reloadOutreach]
  );
  useEffect(() => {
    reloadOutreach();
  }, [reloadOutreach]);

  const buckets = useMemo(() => {
    const filteredByOutreach = rows.filter((c) => {
      if (outreachFilter !== "has" && outreachFilter !== "none") return true;
      const touched = Boolean(
        c.workspace_id && outreachMap[c.workspace_id]?.last_outreach_at
      );
      return outreachFilter === "has" ? touched : !touched;
    });
    return BUCKETS.map((b) => ({
      bucket: b,
      list: filteredByOutreach
        .filter((c) => b.test(pct(c)))
        .sort((a, b) => pct(b) - pct(a)),
    })).filter((g) => g.list.length > 0);
  }, [rows, outreachFilter, outreachMap]);

  const visibleRows = useMemo(
    () => buckets.flatMap((g) => g.list),
    [buckets]
  );

  function rowKey(c: Customer): string {
    return c.workspace_id ?? c.stripe_customer_id ?? c.workspace_name ?? "row";
  }

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const selectedCustomers = useMemo(
    () => visibleRows.filter((c) => selected.has(rowKey(c))),
    [visibleRows, selected]
  );

  return (
    <>
      <div className="flex items-center gap-3 mb-4 text-sm">
        <span className="text-xs text-muted">Filter:</span>
        <CsmSelector csms={csms} />
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
        <span className="text-xs text-muted ml-auto">
          {rows.length} Enterprise account{rows.length === 1 ? "" : "s"} at ≥75% of cap
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-muted">
          <strong>{selected.size}</strong> selected
        </span>
        <button
          onClick={() =>
            setSelected(new Set(visibleRows.map((c) => rowKey(c))))
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
            const ids = selectedCustomers
              .map((c) => c.workspace_id)
              .filter((id): id is string => Boolean(id));
            if (ids.length === 0) return;
            const r = await fetch("/api/proactive-outreach", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ workspace_ids: ids }),
            });
            if (r.ok) reloadOutreach();
          }}
          disabled={selected.size === 0}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
          title="Stamp the selected rows as outreach-logged. Stops the 5-day nudge cycle for them."
        >
          ✓ Mark outreach logged
        </button>
        <button
          onClick={async () => {
            const ids = selectedCustomers
              .map((c) => c.workspace_id)
              .filter((id): id is string => Boolean(id));
            if (ids.length === 0) return;
            if (
              !confirm(
                `Clear the proactive-outreach state (pinged / nudged / outreach-logged) for ${ids.length} account${
                  ids.length === 1 ? "" : "s"
                }? This re-enables ping eligibility immediately, ignoring the 5-day dedupe.`
              )
            ) {
              return;
            }
            await clearProactive(ids);
          }}
          disabled={selected.size === 0}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
          title="Wipe the ping / nudge / outreach-logged state for the selected rows so a fresh ping can fire before the 5-day dedupe expires. Useful when an account needs a re-ping after a no-response window."
        >
          ↻ Clear ping status
        </button>
        <button
          onClick={async () => {
            // Pull workspace_ids straight off the selected customers
            // — this is the same path that "Mark outreach logged"
            // above uses, so the behavior stays consistent.
            const ids = selectedCustomers
              .map((c) => c.workspace_id)
              .filter((id): id is string => Boolean(id));
            if (ids.length === 0) return;
            setSweepBusy(true);
            setSweepReport(null);
            try {
              const r = await fetch("/api/proactive-outreach/sweep", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspace_ids: ids }),
              });
              const j = (await r.json()) as {
                ok?: boolean;
                error?: string;
                scanned?: number;
                pings_sent?: number;
                nudges_sent?: number;
                skipped_outreach_logged?: number;
                skipped_already_pinged?: number;
                skipped_recent_nudge?: number;
                failures?: { workspace: string; error: string }[];
              };
              if (!r.ok || !j.ok) {
                throw new Error(j.error ?? `HTTP ${r.status}`);
              }
              const bits: string[] = [];
              bits.push(`Scanned ${j.scanned ?? 0} selected`);
              if (j.pings_sent) bits.push(`pinged ${j.pings_sent}`);
              if (j.nudges_sent) bits.push(`nudged ${j.nudges_sent}`);
              if (j.skipped_outreach_logged)
                bits.push(`${j.skipped_outreach_logged} already actioned`);
              if (j.skipped_already_pinged)
                bits.push(`${j.skipped_already_pinged} already pinged`);
              if (j.skipped_recent_nudge)
                bits.push(`${j.skipped_recent_nudge} recently nudged`);
              if (j.failures?.length)
                bits.push(`${j.failures.length} failures`);
              setSweepReport(bits.join(" · "));
              reloadOutreach();
            } catch (e) {
              setSweepReport(
                `Sweep failed: ${e instanceof Error ? e.message : "unknown"}`
              );
            } finally {
              setSweepBusy(false);
              setTimeout(() => setSweepReport(null), 8000);
            }
          }}
          disabled={sweepBusy || selected.size === 0}
          className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
          title="Post a Slack ping in the proactive-outreach channel for every CHECKED row that hasn't already been pinged or actioned. The daily cron handles the full eligible cohort automatically."
        >
          {sweepBusy
            ? "Pinging…"
            : `📣 Ping ${selected.size > 0 ? `${selected.size} ` : ""}selected on Slack`}
        </button>
        <div className="flex-1" />
        {/* Enterprise outreach drafts auto-CC the assigned CSM per the
         *  brief. Same ccLookup pattern used on the Past Due Enterprise
         *  bulk launcher. */}
        <BulkEmailLauncher
          customers={selectedCustomers}
          defaultTemplateId="approaching-ent"
          disabled={selected.size === 0}
          label="✉️ Email selected (CCs CSM)"
          ccLookup={(c) => c.customer_success_manager_email ?? null}
          trackingIdFor={(c) => c.workspace_id ?? null}
          onDraftCreated={async (ids) => {
            // Auto-stamp `last_outreach_at` so the row picks up the
            // green Outreach-logged badge AND the 5-day nudge cycle
            // stops. Mirrors the existing manual "Mark outreach logged"
            // button.
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
      </div>

      {sweepReport ? (
        <div className="text-xs text-muted mb-3">{sweepReport}</div>
      ) : null}

      {buckets.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No Enterprise customers at or above 75% of cap. Nicely done.
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
                  {/* Chevron column — narrow click-target for the
                   *  expand/collapse toggle, matches /csm pattern. */}
                  <col className="w-6" />
                  <col className="w-[22%]" />
                  <col className="w-[8%]" />
                  <col className="w-[12%]" />
                  <col className="w-[9%]" />
                  <col className="w-[12%]" />
                  <col className="w-[9%]" />
                  {/* Actions — Masquerade + h. + Draft. Bumped from 10%
                   *  so text "Masquerade" doesn't spill leftward. */}
                  <col className="w-[18%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs text-muted border-y border-border text-left">
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 font-medium text-right">% of cap</th>
                    <th className="px-3 py-2 font-medium text-right">Subs / cap</th>
                    <th className="px-3 py-2 font-medium text-right">Price</th>
                    <th className="px-3 py-2 font-medium">CSM</th>
                    <th className="px-3 py-2 font-medium text-right">ARR</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => {
                    const k = rowKey(c);
                    const isOpen = expanded.has(k);
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
                          aria-label={`Select ${c.company_name ?? c.workspace_name ?? "row"}`}
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
                          <span>{c.company_name ?? c.workspace_name ?? "—"}</span>
                          <ProactiveStatusBadge
                            entry={
                              c.workspace_id
                                ? outreachMap[c.workspace_id]
                                : undefined
                            }
                            onClear={
                              c.workspace_id
                                ? () => {
                                    void clearProactive([c.workspace_id!]);
                                  }
                                : undefined
                            }
                          />
                        </div>
                        <div className="text-xs text-muted truncate">
                          {c.property_main_contact ?? c.owner_email ?? ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {fmtPct(pct(c))}
                      </td>
                      <td className="px-3 py-2 text-right text-muted">
                        <div>{fmtNumber(c.active_subs)}</div>
                        <div className="text-xs text-muted">
                          / {fmtNumber(c.max_subscriptions)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-muted">
                        {priceLabel(c)}
                      </td>
                      <td className="px-3 py-2 text-muted break-words">
                        {c.customer_success_manager?.replace(/_/g, " ") ?? (
                          <span className="text-subtle italic">unassigned</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtCurrency(c.arr)}
                      </td>
                      <td
                        className="px-3 py-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <RowActions customer={c} onDraft={setOutreachFor} />
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="bg-blue-50/40 dark:bg-blue-500/10 border-b border-border">
                        <td colSpan={9} className="px-6 py-4">
                          <CustomerDetailPanel customer={c} />
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

      {outreachFor ? (
        <OutreachModal
          customer={outreachFor}
          onClose={() => setOutreachFor(null)}
        />
      ) : null}
    </>
  );
}

/** Inline chip showing where this account sits in the proactive-outreach
 *  lifecycle: pinged in Slack, outreach logged, or nudged. Invisible
 *  when no state exists yet (most rows on first load).
 *
 *  When `onClear` is provided AND a status is visible, a small "×"
 *  affordance follows the chip — click to wipe the proactive entry
 *  so the workspace becomes ping-eligible again (bypasses the
 *  5-day dedupe). */
function ProactiveStatusBadge({
  entry,
  onClear,
}: {
  entry?: import("@/lib/data/proactive-outreach").ProactiveOutreachEntry;
  onClear?: () => void;
}) {
  if (!entry) return null;

  const clearChip = onClear ? (
    <button
      type="button"
      onClick={(e) => {
        // The row is wrapped in a click-to-expand handler; without
        // stopPropagation a clear-click would also toggle the
        // detail panel.
        e.stopPropagation();
        if (
          confirm(
            "Clear the proactive-outreach state for this account? This re-enables a fresh ping immediately, ignoring the 5-day dedupe."
          )
        ) {
          onClear();
        }
      }}
      title="Clear pinged / nudged / outreach-logged status so a fresh ping can fire."
      className="ml-1 text-[10px] text-muted hover:text-red-600 hover:underline cursor-pointer"
      aria-label="Clear proactive outreach status"
    >
      × clear
    </button>
  ) : null;

  if (entry.last_outreach_at) {
    return (
      <span className="inline-flex items-baseline gap-1">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
          title={`Outreach logged ${fmtDate(entry.last_outreach_at)}${
            entry.last_outreach_by ? ` by ${entry.last_outreach_by}` : ""
          }`}
        >
          <span aria-hidden>✓</span>
          Outreach logged
        </span>
        {clearChip}
      </span>
    );
  }
  if (entry.last_nudge_at) {
    return (
      <span className="inline-flex items-baseline gap-1">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
          title={`Nudged ${fmtDate(entry.last_nudge_at)} · pinged ${fmtDate(entry.ping_sent_at)}`}
        >
          Nudge sent
        </span>
        {clearChip}
      </span>
    );
  }
  if (entry.ping_sent_at) {
    return (
      <span className="inline-flex items-baseline gap-1">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"
          title={`Slack ping fired ${fmtDate(entry.ping_sent_at)}`}
        >
          Pinged
        </span>
        {clearChip}
      </span>
    );
  }
  return null;
}
