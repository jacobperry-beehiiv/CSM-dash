import type { LifecycleStep } from "./card";

/**
 * The Live board's "Renewal" column shows this fixed 5-item checklist
 * instead of the live: playbook — a different VIEW of the exact same
 * `lifecycle_stage` field the AM Renewals tab's dropdown already
 * edits (not a new field, not a parallel write path). Deliberately
 * hardcoded rather than driven by settings.am.lifecycle_stages: per
 * product decision, this is a fixed set regardless of what the AM
 * team has configured there.
 *
 * Consistency is what matters here — whatever sets `lifecycle_stage`
 * (this checklist, the AM Renewals dropdown, anything else) is
 * immediately reflected everywhere else, because they all read/write
 * the one value via the same /api/customer-overrides route. A value
 * outside this list (HubSpot's own "Mid-Year" / "AM Aligned", or
 * "Pricing Negotiation") isn't an error — those stages can co-occur
 * with any point in this checklist, so per product decision this view
 * just shows nothing checked rather than guessing where they'd map.
 */
export const RENEWAL_STAGE_STEPS = [
  "First Outreach Sent",
  "Follow Up Sent",
  "Call Scheduled",
  "Renewal Confirmed",
  "Renewal Lost",
];

/**
 * First 3 are genuinely sequential (a CSM did outreach, then a
 * follow-up, then scheduled a call — all true at once) so checking
 * one implies everything before it happened too. The last two are
 * mutually exclusive terminal outcomes, not a 4th/5th sequential step
 * — a lost renewal was never "confirmed" even though its index is
 * later in the list, so that one combination is special-cased below.
 */
export function buildRenewalChecklist(
  lifecycleStage: string | null | undefined
): LifecycleStep[] {
  const current = lifecycleStage?.trim() || null;
  const currentIndex = current ? RENEWAL_STAGE_STEPS.indexOf(current) : -1;
  return RENEWAL_STAGE_STEPS.map((label) => {
    const index = RENEWAL_STAGE_STEPS.indexOf(label);
    let completed = currentIndex >= 0 && index <= currentIndex;
    if (current === "Renewal Lost" && label === "Renewal Confirmed") {
      completed = false;
    }
    return { id: label, title: label, completed, due_date: null };
  });
}

/** Same write path the old Renewal board's drag used — POSTs the
 *  literal stage label to /api/customer-overrides' `lifecycle_stage`
 *  field. Checking a box here means "set the stage to this," not
 *  "toggle" — the single underlying value can't represent a
 *  checked/unchecked state per item independently, so clicking any
 *  item jumps straight to it (including backwards, if a CSM wants to
 *  correct an earlier mis-click). */
export async function setLifecycleStage(
  workspaceId: string,
  stage: string | null
): Promise<void> {
  const r = await fetch("/api/customer-overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, lifecycle_stage: stage }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${r.status}`);
  }
}
