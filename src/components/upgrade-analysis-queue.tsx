"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  OverallVerdict,
  StoredUpgradeAnalysis,
} from "@/lib/engines/upgrade-analysis/types";
import type { Customer } from "@/lib/types";
import { UpgradeAnalysisPanel } from "./upgrade-analysis-panel";

/**
 * Review-queue tab renderer for /csm?tab=upgrade-analysis. Fetches
 * every stored scan from /api/upgrade-analysis/list, filters to the
 * ones with `escalation.needed === true`, joins against the current
 * customer book so we can render pub name + owner, and lists them
 * sorted by scan recency.
 *
 * Row expand mounts the full UpgradeAnalysisPanel (with the cached
 * report passed in via `initial`, so no additional API round-trip).
 *
 * This is NOT a source of new scans — it's the AM-initiated inbox
 * D&C works. Fresh scans still originate from the customer-row CTA.
 */

interface Props {
  /** Book scoped by ?csm. Passing full list lets us do the pub_id →
   *  customer lookup without another server round-trip. */
  customers: Customer[];
  /** Session's CSM handle (null in "all CSMs" view) — surfaced in
   *  the empty-state copy so the reviewer knows the filter is on. */
  csmScope: string | null;
}

type FilterChip = "escalation_needed" | "all";

interface ApiResponse {
  scans?: StoredUpgradeAnalysis[];
  error?: string;
}

const VERDICT_STYLES: Record<
  OverallVerdict,
  { label: string; classes: string }
> = {
  clear: {
    label: "Clear",
    classes:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30",
  },
  review_needed: {
    label: "Review",
    classes:
      "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  },
  hold: {
    label: "Hold",
    classes:
      "bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30",
  },
};

export function UpgradeAnalysisQueue({ customers, csmScope }: Props) {
  const [scans, setScans] = useState<StoredUpgradeAnalysis[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterChip>("escalation_needed");
  const [expandedPubId, setExpandedPubId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/upgrade-analysis/list")
      .then((r) => r.json())
      .then((body: ApiResponse) => {
        if (cancelled) return;
        if (body.error) {
          setError(body.error);
        } else {
          setScans(body.scans ?? []);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // pub_id → Customer for joining scan → row context.
  const customerByPubId = useMemo(() => {
    const map = new Map<string, Customer>();
    for (const c of customers) {
      if (c.workspace_id) map.set(c.workspace_id, c);
    }
    return map;
  }, [customers]);

  const filtered = useMemo(() => {
    if (!scans) return [];
    if (filter === "escalation_needed") {
      return scans.filter((s) => s.report.escalation.needed);
    }
    return scans;
  }, [scans, filter]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-fg">
          Upgrade-analysis queue
        </h2>
        <p className="text-sm text-muted mt-0.5">
          Reports flagged for D&amp;C review. New scans originate from the
          customer row&apos;s &ldquo;Run upgrade analysis&rdquo; button — this tab is the
          inbox for AM-initiated scans that flagged red/amber.
          {csmScope ? (
            <>
              {" "}
              Scoped to <strong>{csmScope.replace(/_/g, " ")}</strong>.
            </>
          ) : null}
        </p>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-1.5">
        <FilterChipButton
          active={filter === "escalation_needed"}
          onClick={() => setFilter("escalation_needed")}
        >
          Escalation needed
          {scans
            ? ` (${scans.filter((s) => s.report.escalation.needed).length})`
            : ""}
        </FilterChipButton>
        <FilterChipButton
          active={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All scans{scans ? ` (${scans.length})` : ""}
        </FilterChipButton>
      </div>

      {error ? (
        <div className="rounded border border-red-500/40 bg-red-500/10 text-sm text-red-700 dark:text-red-300 p-3">
          Failed to load: {error}
        </div>
      ) : loading ? (
        <div className="text-sm text-muted italic">Loading scans…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted italic">
          No scans matching the filter yet. Run an upgrade analysis from a
          customer row&apos;s expand panel to seed the queue.
        </div>
      ) : (
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
              <tr>
                <th className="text-left px-3 py-2">Customer</th>
                <th className="text-left px-3 py-2">Owner</th>
                <th className="text-left px-3 py-2">Verdict</th>
                <th className="text-left px-3 py-2">Escalation reasons</th>
                <th className="text-left px-3 py-2">Scanned</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const c = customerByPubId.get(s.report.pub_id);
                const style = VERDICT_STYLES[s.report.overall];
                const expanded = expandedPubId === s.report.pub_id;
                return (
                  <>
                    <tr
                      key={s.report.pub_id}
                      className="border-t border-border hover:bg-surface-2 cursor-pointer"
                      onClick={() =>
                        setExpandedPubId(expanded ? null : s.report.pub_id)
                      }
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium text-fg">
                          {c?.company_name ??
                            c?.workspace_name ??
                            <span className="text-muted italic">
                              Unknown pub
                            </span>}
                        </div>
                        <div className="text-[10px] text-muted font-mono">
                          {s.report.pub_id.slice(0, 8)}…
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {c?.owner_email ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${style.classes}`}
                        >
                          {style.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {s.report.escalation.reasons.length === 0 ? (
                          <span className="text-muted italic">None</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {s.report.escalation.reasons
                              .slice(0, 2)
                              .map((r, i) => (
                                <li key={i}>
                                  <code className="bg-surface-2 px-1 rounded text-[10px]">
                                    {r.code}
                                  </code>
                                </li>
                              ))}
                            {s.report.escalation.reasons.length > 2 ? (
                              <li className="text-muted">
                                +{s.report.escalation.reasons.length - 2} more
                              </li>
                            ) : null}
                          </ul>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted whitespace-nowrap">
                        {new Date(s.last_scanned_at).toLocaleString(
                          undefined,
                          { dateStyle: "medium", timeStyle: "short" }
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted">
                        {expanded ? "▲" : "▼"}
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-3 bg-surface">
                          <UpgradeAnalysisPanel
                            publicationId={s.report.pub_id}
                            organizationId={s.report.org_id}
                            initial={{
                              report: s.report,
                              last_scanned_at: s.last_scanned_at,
                            }}
                            autoLoad={false}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded border ${
        active
          ? "border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
          : "border-border bg-surface hover:bg-surface-2 text-fg"
      }`}
    >
      {children}
    </button>
  );
}
