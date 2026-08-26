"use client";

import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { EnterpriseOnlyPanel } from "./enterprise-only-panel";
import { ApproachingEnterprisePanel } from "./approaching-enterprise-panel";
import type { Customer } from "@/lib/types";
import type { ApproachingEntRow } from "@/lib/engines/am-cohorts";

/**
 * Phase 2 — Proactive Outreach pillar (per AM Hackathon brief).
 *
 * Consolidates the two cohorts that used to be top-level AM tabs into
 * a single pillar with sub-tabs:
 *
 *   • Enterprise approaching cap — Customers whose active subs are
 *     ≥85% of their Enterprise plan limit. Bulk drafts CC the assigned
 *     CSM automatically.
 *   • Approaching Enterprise — Non-Enterprise accounts approaching the
 *     ~100K subscriber threshold where an Enterprise conversation makes
 *     sense. Multiple template options available via the bulk-draft
 *     modal so AM can pick the right pitch per usage profile.
 *
 * Sub-tab is URL-synced via ?potab=. Default lands on "Enterprise" as
 * the more time-sensitive cohort.
 */

type ProactiveSubtab = "enterprise" | "approaching";

interface Props {
  enterpriseRows: Customer[];
  approachingRows: ApproachingEntRow[];
  csms: string[];
  /** Full customer book — threaded through to the Approaching
   *  Enterprise sub-tab's D&C review queue so scan rows can join
   *  workspace_name / owner_email. */
  allCustomers: Customer[];
  /** Feature-flag gate for the D&C Upgrade Analysis surfaces under
   *  Approaching Enterprise (row panel + review queue). */
  upgradeAnalysisEnabled: boolean;
  /** Effective CSM filter, forwarded to the queue's own scope hint. */
  csm: string | null;
}

const SUBTAB_LABELS: Record<ProactiveSubtab, string> = {
  enterprise: "Enterprise approaching cap",
  approaching: "Approaching Enterprise",
};

export function ProactiveOutreachPanel({
  enterpriseRows,
  approachingRows,
  csms,
  allCustomers,
  upgradeAnalysisEnabled,
  csm,
}: Props) {
  const [subtabRaw, setSubtab] = useUrlSearch("potab");
  const subtab: ProactiveSubtab =
    subtabRaw === "approaching" ? "approaching" : "enterprise";

  return (
    <>
      <div className="flex flex-wrap items-center gap-1 mb-4 border-b border-border">
        {(["enterprise", "approaching"] as const).map((t) => {
          const count =
            t === "enterprise" ? enterpriseRows.length : approachingRows.length;
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

      {subtab === "enterprise" ? (
        <EnterpriseOnlyPanel rows={enterpriseRows} csms={csms} />
      ) : (
        <ApproachingEnterprisePanel
          rows={approachingRows}
          upgradeAnalysisEnabled={upgradeAnalysisEnabled}
          allCustomers={allCustomers}
          csmScope={csm}
        />
      )}
    </>
  );
}
