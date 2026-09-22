"use client";

import { useState } from "react";
import { fmtDate } from "../format";
import type { NeedsReviewReason } from "@/lib/data/enterprise-requests-types";

/** One `needs_review` row, flattened by the page so this component
 *  doesn't need the full snapshot shape or the workspace lookup. */
export interface ExceptionRow {
  workspace_id: string;
  workspace_name: string | null;
  company_name: string | null;
  csm_handle: string | null;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  url: string;
  work_type: string | null;
  reason: NeedsReviewReason | null;
  promotion_source: string | null;
  promoted_at: string | null;
  ship_url: string | null;
}

interface Props {
  rows: ExceptionRow[];
}

interface RowState {
  saving: boolean;
  decided: "confirmed" | "dismissed" | null;
  error: string | null;
}

/** Plain-language framing of each reason, plus what the reviewer
 *  should actually go check. The reason codes are precise but opaque
 *  on their own — someone clearing this queue shouldn't have to read
 *  the sweep source to know what "unresolved_work_type" implies. */
const REASON_COPY: Record<
  NeedsReviewReason,
  { label: string; detail: string; tone: string }
> = {
  feature_awaiting_changelog: {
    label: "Feature, no changelog post yet",
    detail:
      "Seen in #devs-shipped but not #topic-product-changelog. Merged isn't released — features routinely sit behind a flag. Confirm only if you can verify the customer can actually see it.",
    tone: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  },
  unresolved_work_type: {
    label: "Unknown work type",
    detail:
      "Neither Linear's label nor the ship parens said Bug / UI-UX / Feature, so we can't reason about whether merged means customer-visible. Check the Linear ticket.",
    tone: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
  },
  changelog_fuzzy_match: {
    label: "Fuzzy changelog match",
    detail:
      "Matched a changelog post on title/description similarity rather than an exact Linear link. Verify it's the same thing before confirming.",
    tone: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
  },
};

export function ExceptionsReview({ rows }: Props) {
  const [state, setState] = useState<Record<string, RowState>>({});

  function keyFor(r: ExceptionRow): string {
    return `${r.workspace_id}:${r.linear_issue_id}`;
  }

  async function decide(
    row: ExceptionRow,
    decision: "confirmed" | "dismissed"
  ) {
    const key = keyFor(row);
    setState((prev) => ({
      ...prev,
      [key]: { saving: true, decided: null, error: null },
    }));
    try {
      const r = await fetch("/api/enterprise-requests/exceptions/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: row.workspace_id,
          linear_issue_id: row.linear_issue_id,
          decision,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setState((prev) => ({
        ...prev,
        [key]: { saving: false, decided: decision, error: null },
      }));
    } catch (e) {
      setState((prev) => ({
        ...prev,
        [key]: {
          saving: false,
          decided: null,
          error: e instanceof Error ? e.message : "Failed",
        },
      }));
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
        Nothing waiting on review. Every shipped signal in the snapshot
        either cleared the confidence bar automatically or has already
        been decided.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-fg text-left text-xs uppercase tracking-wider">
          <tr>
            <th className="px-3 py-2 font-medium">Request</th>
            <th className="px-3 py-2 font-medium">Customer</th>
            <th className="px-3 py-2 font-medium">Why it&rsquo;s here</th>
            <th className="px-3 py-2 font-medium">Detected</th>
            <th className="px-3 py-2 font-medium">Decision</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((row) => {
            const key = keyFor(row);
            const st = state[key];
            const reason = row.reason ? REASON_COPY[row.reason] : null;
            return (
              <tr key={key} className={st?.decided ? "opacity-60" : ""}>
                <td className="px-3 py-2 align-top">
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {row.linear_identifier}
                  </a>
                  <div className="text-fg break-words">{row.title}</div>
                  <div className="text-[11px] text-muted mt-0.5 flex gap-2 flex-wrap">
                    {row.work_type ? <span>{row.work_type}</span> : null}
                    {row.ship_url ? (
                      <a
                        href={row.ship_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:no-underline"
                      >
                        ship post ↗
                      </a>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="text-fg">
                    {row.company_name ??
                      row.workspace_name ??
                      row.workspace_id}
                  </div>
                  {row.csm_handle ? (
                    <div className="text-[11px] text-muted">
                      {row.csm_handle.replace(/_/g, " ")}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top max-w-sm">
                  {reason ? (
                    <>
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${reason.tone}`}
                      >
                        {reason.label}
                      </span>
                      <div className="text-[11px] text-muted mt-1 leading-snug">
                        {reason.detail}
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-muted italic">
                      needs review
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs text-muted whitespace-nowrap">
                  {row.promoted_at ? fmtDate(row.promoted_at) : "—"}
                </td>
                <td className="px-3 py-2 align-top">
                  {st?.decided ? (
                    <span
                      className={
                        st.decided === "confirmed"
                          ? "text-xs font-medium text-emerald-700 dark:text-emerald-300"
                          : "text-xs font-medium text-muted"
                      }
                    >
                      {st.decided === "confirmed"
                        ? "✓ Confirmed — next digest will notify"
                        : "Dismissed"}
                    </span>
                  ) : (
                    <div className="flex flex-col gap-1 items-start">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => void decide(row, "confirmed")}
                          disabled={st?.saving}
                          title="Mark this ship as real and customer-visible. The next weekly digest will DM the CSM."
                          className="px-2 py-1 bg-emerald-600 text-white rounded-md text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {st?.saving ? "…" : "Confirm"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void decide(row, "dismissed")}
                          disabled={st?.saving}
                          title="Not a customer-visible ship. Drops the Live badge off the customer profile."
                          className="px-2 py-1 border border-border-strong text-fg rounded-md text-xs font-medium hover:bg-canvas disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </div>
                      {st?.error ? (
                        <span className="text-[10px] text-red-700 dark:text-red-300 break-words">
                          {st.error}
                        </span>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
