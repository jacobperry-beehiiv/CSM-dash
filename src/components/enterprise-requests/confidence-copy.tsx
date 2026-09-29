"use client";

import { useState } from "react";
import type {
  NeedsReviewReason,
  PromotionConfidence,
  PromotionSource,
  WorkTypeLabel,
} from "@/lib/data/enterprise-requests-types";

/**
 * User-facing explanation of how a request gets called "live".
 *
 * The rules live in `linearStateToDerived` (state) and the shipped
 * sweep's `recordShipSignals` (corroboration) — useless to a CSM
 * looking at a badge and wondering whether they can email a customer
 * about it. This module is the single place those rules are rendered
 * in plain language, shared by the Live requests tab and the review
 * queue so the two can't drift apart.
 *
 * If you change either of those, change these strings.
 *
 * NOTE: this used to describe a gate that HELD ships back from CSMs
 * until Slack corroborated them. Nothing is held back now. Linear's
 * "Done (live in app)" decides what's live; the #devs-shipped match is
 * a yes/no shown beside it so a CSM knows whether to double-check.
 */

export const REASON_COPY: Record<
  NeedsReviewReason,
  { label: string; detail: string; tone: string }
> = {
  feature_awaiting_changelog: {
    label: "No changelog post",
    detail:
      "Seen in #devs-shipped but never announced in #topic-product-changelog. Usually fine — most ships never get a changelog post. Worth a look if the customer is expecting something highly visible.",
    tone: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  },
  unresolved_work_type: {
    label: "Unknown work type",
    detail:
      "The Linear ticket carries no Type of Work label. Doesn't affect whether it's live — Linear's state decides that — but it means we can't tell you what kind of change it was.",
    tone: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
  },
  changelog_fuzzy_match: {
    label: "Fuzzy changelog match",
    detail:
      "Matched a changelog post on title similarity rather than an exact Linear link. The ship link on this row might point at a different feature.",
    tone: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
  },
};

/**
 * One-line answer to "how sure are we this is out?" — rendered under
 * each ticket so the basis travels with the row instead of living in
 * a help panel nobody opens twice.
 */
export function confidenceBasis(args: {
  confidence: PromotionConfidence;
  source: PromotionSource | null;
  work_type: WorkTypeLabel | null;
  needs_review_reason: NeedsReviewReason | null;
  reviewed_by: string | null;
  /** Did a #devs-shipped release post carry this ticket? */
  devsShippedMatch?: boolean;
}): string {
  if (args.reviewed_by) {
    return `Confirmed by ${args.reviewed_by} from the review queue.`;
  }
  if (args.devsShippedMatch ?? args.confidence === "confirmed") {
    switch (args.source) {
      case "changelog":
        return "Live per Linear, and the changelog post links this exact ticket — it's in a customer-facing release note.";
      case "changelog_fuzzy":
        return "Live per Linear. A changelog post matched on title similarity, so the ship link may point at something adjacent.";
      case "manual":
        return "Live per Linear, stamped manually by an admin.";
      default:
        return "Live per Linear, and a #devs-shipped release post carried this ticket.";
    }
  }
  return "Live per Linear, but no #devs-shipped post carrying this ticket was found — worth confirming before you promise a date.";
}

/**
 * Collapsible rules panel. Collapsed by default: it's reference
 * material, not something to re-read every visit, and the per-row
 * basis line carries the answer most of the time.
 */
export function ConfidenceExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-canvas/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-fg hover:bg-canvas/70 rounded-lg"
        aria-expanded={open}
      >
        <span className="text-muted">{open ? "▾" : "▸"}</span>
        <span className="font-medium">How we decide something is live</span>
        <span className="ml-auto text-[11px] text-muted">
          what the ship badge means
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3 text-muted">
          <p className="max-w-prose">
            <strong className="text-fg">Linear decides.</strong> A request
            shows here when its Linear ticket is in a completed state —
            on the Feature Requests team that state is literally named{" "}
            <code className="font-mono">Done (live in app)</code>. That&rsquo;s
            a person asserting the customer can use it, which is the
            best signal available.
          </p>

          <p className="max-w-prose">
            Separately, we check{" "}
            <code className="font-mono">#devs-shipped</code> for a release
            post carrying the ticket, and show the answer as a badge:
          </p>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-fg">
                  <th className="border-b border-border py-1 pr-3 font-medium">
                    Badge
                  </th>
                  <th className="border-b border-border py-1 pr-3 font-medium">
                    What it means
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "SHIP MATCHED ✓",
                    "A #devs-shipped release post lists this ticket. The code is provably out. Send with confidence.",
                  ],
                  [
                    "NO SHIP POST MATCHED",
                    "Linear says live; we couldn't find the release that carried it. Usually means the ship went out under a project ticket or before we started watching — occasionally it means the ticket was closed without the code going out. Check before you promise a date.",
                  ],
                ].map(([signal, result]) => (
                  <tr key={signal}>
                    <td className="border-b border-border/60 py-1 pr-3 font-semibold whitespace-nowrap">
                      {signal}
                    </td>
                    <td className="border-b border-border/60 py-1 pr-3">
                      {result}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="max-w-prose">
            Both kinds reach you — the Monday digest and your to-do list
            included. Unmatched ones are flagged in the message rather
            than withheld, and they also collect in the{" "}
            <a
              href="/settings/enterprise-requests/exceptions"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              review queue
            </a>{" "}
            so someone can reconcile them in a batch.
          </p>

          <p className="max-w-prose italic">
            This is the opposite of the earlier tradeoff, on purpose.
            Holding ships back until Slack corroborated them meant CSMs
            heard about almost nothing; a flag you can see beats a
            notification you never get.
          </p>
        </div>
      ) : null}
    </div>
  );
}
