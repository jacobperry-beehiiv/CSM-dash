import type { AtRiskAccount, Customer } from "@/lib/types";
import type { PersonalTodo } from "@/lib/personal-todos/types";
import { daysUntilRenewal } from "@/lib/renewals/date";
import { intervalBucket } from "@/lib/customer-helpers";
import { matchPlaybookTodos } from "./todos";
import { buildRenewalChecklist } from "./renewal-checklist";
import { resolveTodoStage } from "./step-stage-config";
import {
  atRiskSummary,
  isEditableBy,
  type LifecycleCard,
  type LifecycleStep,
} from "./card";

/**
 * Lifecycle tab — Live board. Fully computed, not draggable, no
 * stored field — which column a card is in is purely "how many days
 * until this contract renews," bucketed into quarters. The "Renewal"
 * column deliberately lines up with the existing 90-day
 * renewal-milestone trigger (src/lib/engines/renewal-milestones.ts)
 * so this board's last column means the same thing that engine
 * already means by "renewal window."
 *
 * There is no separate Renewal board anymore — a card that renews
 * (its `contract_renewal` rolls forward once the deal is actually
 * renewed in HubSpot) automatically computes back to Q1 on the next
 * page load. Nothing here resets it manually; it's the same date math
 * that placed it in "Renewal" in the first place, just re-run against
 * a now-later date.
 *
 * Each column shows the checklist that's actually relevant to it:
 * Q1/Q2/Q3 (and Q4) show whichever matched playbook steps are
 * CONFIGURED (at /settings/lifecycle-steps) to one of
 * LIVE_ASSIGNABLE_STAGES below — this is stage-based, not
 * step_key-prefix-based, so a step Normbot originally handed out via
 * the onboarding flow shows up here too if an admin reassigns it.
 * "Renewal" never shows playbook steps at all; it always shows the
 * fixed 5-item renewal-stage checklist instead (renewal-checklist.ts),
 * a different VIEW of the same `lifecycle_stage` field the AM
 * Renewals tab's dropdown already edits, not a new field.
 *
 * "Q4" is a fifth, deliberately-separate column for monthly-billed
 * customers — the Renewals pipeline (this board's "Renewal" column,
 * the AM Renewals tab, the renewal-milestones engine) is fundamentally
 * an annual-contract motion, so a monthly customer never belongs in
 * it. Checked FIRST in computeLiveQuarter, before any date math, so a
 * monthly customer can never land in "Renewal" even if they happen to
 * have a contract_renewal value populated.
 */

const RENEWAL_WINDOW_DAYS = 90;
const Q3_WINDOW_DAYS = 180;
const Q2_WINDOW_DAYS = 270;

/** Monthly-billed customers land here regardless of contract_renewal
 *  — see the module doc comment. Not part of the Q1→Renewal countdown
 *  sequence, so it isn't included in LIVE_QUARTER_COLUMNS ordering
 *  logic anywhere beyond live-board.tsx's own column list. */
export const MONTHLY_COLUMN = "Q4";

/** "Live" is the flat, undated grouping for manually-created "ongoing"
 *  to-dos (see personal-todos-panel.tsx's checklist-group picker) —
 *  unlike a real playbook step, a one-off task doesn't have a due-date
 *  cadence that maps naturally onto a specific quarter. Listed first
 *  in LIVE_ASSIGNABLE_STAGES so it renders above Q1/Q2/Q3 on the card
 *  and appears first in the /settings/lifecycle-steps dropdown too —
 *  an admin CAN also reassign a real playbook step here if they want
 *  it treated as ongoing rather than quarter-specific. */
export const LIVE_ONGOING_GROUP = "Live";

/** Columns a "live:" playbook step (or a manually-created ongoing
 *  to-do) can be assigned to at /settings/lifecycle-steps. Excludes
 *  "Renewal" — that column never shows playbook steps, only the
 *  renewal-stage checklist. */
export const LIVE_ASSIGNABLE_STAGES = [LIVE_ONGOING_GROUP, "Q1", "Q2", "Q3"];

/**
 * Buckets a customer into one of 5 columns. Monthly-billed customers
 * always land in MONTHLY_COLUMN ("Q4") — see the module doc comment
 * for why. Everyone else is bucketed by days-until-renewal.
 * Non-monthly customers with no `contract_renewal` (contract date
 * never populated in HubSpot) don't have a real renewal date to count
 * down from — by product decision they still cycle through Q1-Renewal
 * rather than being excluded, using `mon_since_1st_ent` (tenure in
 * months) as an approximation: NOT a real renewal signal, only ever
 * used for placement on this one board.
 */
export function computeLiveQuarter(
  customer: Customer,
  now: Date = new Date()
): string {
  if (intervalBucket(customer) === "monthly") return MONTHLY_COLUMN;
  const days = daysUntilRenewal(customer.contract_renewal ?? null, now);
  if (days != null) {
    if (days <= RENEWAL_WINDOW_DAYS) return "Renewal";
    if (days <= Q3_WINDOW_DAYS) return "Q3";
    if (days <= Q2_WINDOW_DAYS) return "Q2";
    return "Q1";
  }
  const tenureMonths = customer.mon_since_1st_ent;
  if (typeof tenureMonths === "number" && tenureMonths >= 0) {
    const monthsIntoCycle = tenureMonths % 12;
    if (monthsIntoCycle < 3) return "Q1";
    if (monthsIntoCycle < 6) return "Q2";
    if (monthsIntoCycle < 9) return "Q3";
    return "Renewal";
  }
  return "Q1";
}

function sortByDueDate(a: PersonalTodo, b: PersonalTodo): number {
  if (!a.due_date) return 1;
  if (!b.due_date) return -1;
  return a.due_date.localeCompare(b.due_date);
}

function stepFromTodo(
  t: PersonalTodo,
  stepStages: Record<string, string | null>
): LifecycleStep {
  return {
    id: t.id,
    title: t.title,
    completed: Boolean(t.completed_at),
    due_date: t.due_date,
    stage: resolveTodoStage(t, stepStages),
    details: t.details,
    completed_at: t.completed_at,
    surface_at: t.surface_at,
  };
}

export function buildLiveCard(
  customer: Customer & { workspace_id: string },
  csmTodos: PersonalTodo[],
  lifecycleStageOverride: string | null | undefined,
  stepStages: Record<string, string | null>,
  atRiskAccount: AtRiskAccount | undefined,
  viewerEmail: string | null | undefined,
  now: Date = new Date()
): LifecycleCard {
  const stage = computeLiveQuarter(customer, now);

  if (stage === "Renewal") {
    const items = buildRenewalChecklist(lifecycleStageOverride);
    // Same "Live" ongoing-checklist a Q1/Q2/Q3/Q4 card shows — an
    // account in the Renewal column is still live day-to-day, so it
    // keeps a place for ad-hoc to-dos separate from the fixed
    // renewal-stage checklist above it. Filtered to ONLY the "Live"
    // group (not the full LIVE_ASSIGNABLE_STAGES set) — Q1/Q2/Q3/Q4
    // groupings don't make sense once a card has left the countdown
    // and landed on Renewal.
    const liveOngoingTodos = matchPlaybookTodos(customer, csmTodos)
      .filter((t) => resolveTodoStage(t, stepStages) === LIVE_ONGOING_GROUP)
      .sort(sortByDueDate);
    return {
      customer,
      stage,
      completedCount: items.filter((s) => s.completed).length,
      totalCount: items.length,
      // Always editable — this writes lifecycle_stage via
      // /api/customer-overrides, which has no per-CSM ownership
      // check, matching the AM Renewals tab's own dropdown today.
      editable: true,
      checklist_kind: "renewal_stage",
      atRisk: atRiskSummary(atRiskAccount),
      steps: items,
      liveOngoingSteps: liveOngoingTodos.map((t) => stepFromTodo(t, stepStages)),
    };
  }

  const liveTodos = matchPlaybookTodos(customer, csmTodos).filter((t) => {
    const s = resolveTodoStage(t, stepStages);
    return s != null && LIVE_ASSIGNABLE_STAGES.includes(s);
  });
  const matched = [...liveTodos].sort(sortByDueDate);
  return {
    customer,
    stage,
    completedCount: matched.filter((t) => t.completed_at).length,
    totalCount: matched.length,
    editable: isEditableBy(customer, viewerEmail),
    checklist_kind: "playbook",
    atRisk: atRiskSummary(atRiskAccount),
    steps: matched.map((t) => stepFromTodo(t, stepStages)),
  };
}
