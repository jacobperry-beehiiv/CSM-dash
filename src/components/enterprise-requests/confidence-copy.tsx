"use client";

import { useState } from "react";
import type {
  NeedsReviewReason,
  PromotionConfidence,
  PromotionSource,
  WorkTypeLabel,
} from "@/lib/data/enterprise-requests-types";

/**
 * User-facing explanation of the shipped-detection confidence gate.
 *
 * The rules live in `decidePromotion` (shipped-sweep engine) and are
 * documented in code comments — useless to a CSM looking at a badge
 * and wondering whether they can email a customer about it. This
 * module is the single place those rules are rendered in plain
 * language, shared by the Live requests tab and the exceptions
 * review queue so the two can't drift apart.
 *
 * If you change `decidePromotion`, change these strings.
 */

export const REASON_COPY: Record<
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

/**
 * One-line answer to "why is this row trusted (or not)?" — rendered
 * under each ticket so the basis travels with the row instead of
 * living in a help panel nobody opens twice.
 */
export function confidenceBasis(args: {
  confidence: PromotionConfidence;
  source: PromotionSource | null;
  work_type: WorkTypeLabel | null;
  needs_review_reason: NeedsReviewReason | null;
  reviewed_by: string | null;
}): string {
  if (args.confidence === "confirmed") {
    if (args.reviewed_by) {
      return `Confirmed by ${args.reviewed_by} from the review queue.`;
    }
    switch (args.source) {
      case "changelog":
        return "Confirmed — the changelog post links this exact Linear ticket, so it's in a customer-facing release note.";
      case "devs_shipped":
        return args.work_type === "Bug"
          ? "Confirmed — a Bug shipped via #devs-shipped. Bugfixes go straight to production; there's no beta-flag stage."
          : args.work_type === "UI/UX Improvement"
            ? "Confirmed — a UI/UX fix shipped via #devs-shipped. These go straight to production; there's no beta-flag stage."
            : "Confirmed via #devs-shipped.";
      case "manual":
        return "Confirmed manually by an admin.";
      default:
        return "Confirmed.";
    }
  }
  const reason = args.needs_review_reason
    ? REASON_COPY[args.needs_review_reason]
    : null;
  return reason
    ? `Not confirmed — ${reason.detail}`
    : "Not confirmed — verify before telling a customer.";
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
        <span className="font-medium">
          How we decide something actually shipped
        </span>
        <span className="ml-auto text-[11px] text-muted">
          why some ships don&rsquo;t notify you
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3 text-muted">
          <p className="max-w-prose">
            Two Slack channels feed shipped-detection:{" "}
            <code className="font-mono">#devs-shipped</code> (a deploy
            landed) and{" "}
            <code className="font-mono">#topic-product-changelog</code>{" "}
            (a customer-facing release note went out). Merged is not the
            same as released — a feature can sit behind a flag for weeks
            after its deploy post. So only some signals are strong
            enough to notify you on.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-fg">
                  <th className="border-b border-border py-1 pr-3 font-medium">
                    Signal
                  </th>
                  <th className="border-b border-border py-1 pr-3 font-medium">
                    Result
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "Changelog post links the exact Linear ticket",
                    "Confirmed — you get notified",
                  ],
                  [
                    "#devs-shipped hit on a Bug",
                    "Confirmed — bugfixes have no beta stage",
                  ],
                  [
                    "#devs-shipped hit on a UI/UX Improvement",
                    "Confirmed — same reasoning",
                  ],
                  [
                    "#devs-shipped hit on a Feature, no changelog yet",
                    "Held for review — may still be behind a flag",
                  ],
                  [
                    "Work type couldn't be determined",
                    "Held for review — we can't reason about it",
                  ],
                  [
                    "Changelog matched on title similarity only",
                    "Held for review — might be a different thing",
                  ],
                ].map(([signal, result]) => (
                  <tr key={signal}>
                    <td className="border-b border-border/60 py-1 pr-3">
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
            Held-for-review ships never reach the Monday digest or your
            to-do list. They wait in the{" "}
            <a
              href="/settings/enterprise-requests/exceptions"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              review queue
            </a>{" "}
            until someone confirms them; confirming makes the row
            eligible for the next digest. Tick{" "}
            <strong>Include unconfirmed</strong> above to see them here
            with an <strong>UNCONFIRMED</strong> badge — useful for
            context, but verify before telling a customer.
          </p>

          <p className="max-w-prose italic">
            The tradeoff is deliberate: hearing about a ship a week late
            is recoverable. Telling a customer their request shipped
            when it&rsquo;s still behind a flag isn&rsquo;t.
          </p>
        </div>
      ) : null}
    </div>
  );
}
