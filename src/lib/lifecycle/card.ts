import type { AtRiskAccount, Customer, RiskFlag } from "@/lib/types";
import { isScheduledFor, todayYmdUtc } from "@/lib/personal-todos/types";

/**
 * Shared card shape rendered by both of the Lifecycle tab's
 * sub-boards (Onboarding, Live — Renewal was folded into Live's own
 * "Renewal" column) — see src/components/lifecycle/kanban-columns.tsx.
 * Each board's own module (onboarding.ts / live-quarter.ts) knows how
 * to build one of these from a Customer; the shared shell and modal
 * only ever deal with this common shape, not board-specific fields.
 */

export interface LifecycleStep {
  id: string;
  title: string;
  completed: boolean;
  due_date: string | null;
  /** ISO timestamp the step was checked off, mirroring
   *  PersonalTodo.completed_at — null while open. Drives the "most
   *  recent 5 completed, rest behind a toggle" truncation in
   *  stage-todo-list.tsx: without a real completion timestamp there'd
   *  be no principled way to decide which completed items are
   *  "recent." Undefined for a "renewal_stage" checklist (see
   *  checklist_kind on LifecycleCard) — that view has no independent
   *  per-item completion history to draw from. */
  completed_at?: string | null;
  /** Which board column this step belongs to (e.g. "Pre-kickoff"),
   *  when the board has that concept — undefined for boards whose
   *  steps don't map onto a stage (e.g. Live's mixed playbook todos
   *  don't correlate to a fiscal quarter). Drives the collapsible
   *  per-stage grouping in stage-todo-list.tsx: a step's group starts
   *  expanded when its stage matches the card's current stage,
   *  collapsed otherwise. */
  stage?: string | null;
  /** Free-text CSM notes — the same PersonalTodo.details field the
   *  Slack-generated playbook steps already carry (context, blockers,
   *  outreach links). Undefined/null renders no note; present, it
   *  drives the "has a note" icon and the click-to-edit textarea in
   *  stage-todo-list.tsx. Only ever populated for "playbook"-kind
   *  steps — the Renewal-stage checklist has no independent details
   *  to carry. */
  details?: string | null;
  /** ISO YYYY-MM-DD, mirroring PersonalTodo.surface_at — when set to a
   *  future date, the step is "scheduled": stage-todo-list.tsx hides
   *  it behind a per-group "Scheduled (N)" toggle instead of showing
   *  it inline, same dormant-until-its-date treatment the main
   *  "Your to-dos" panel already gives these (see isScheduledFor in
   *  personal-todos/types.ts, reused directly by stage-todo-list.tsx
   *  rather than re-implemented). Undefined for a "renewal_stage"
   *  checklist — same scope as completed_at/details. */
  surface_at?: string | null;
}

export interface LifecycleCard {
  /** Full customer record — already sent to the client elsewhere in
   *  this app (CustomerTable, RenewalPanel, …), so this isn't new
   *  exposure. Lets the card modal reuse CustomerDetailPanel verbatim
   *  instead of duplicating its fields here. */
  customer: Customer & { workspace_id: string };
  /** The column this card renders in. Null = the board's fixed
   *  "Unsorted" catch-all. */
  stage: string | null;
  /** Onboarding board only: a one-time suggested column, computed
   *  only when `stage` is null (no real placement yet) and already
   *  validated against the board's configured columns. The board
   *  persists this exactly once (client-triggered write), then it's
   *  an ordinary manually-placed card. Always undefined/null on the
   *  Live board — that one never suggests. */
  suggested_stage?: string | null;
  completedCount: number;
  totalCount: number;
  /** True when the signed-in viewer owns the matched to-dos (can
   *  toggle them in the checklist). Unrelated to drag permission —
   *  any signed-in viewer can drag a card on a draggable board,
   *  matching how lifecycle_stage already works on the Renewals tab.
   *  Always true for a "renewal_stage" checklist (see checklist_kind)
   *  since that writes lifecycle_stage via /api/customer-overrides,
   *  which has no per-CSM ownership check at all. */
  editable: boolean;
  /** Which write path `steps` belongs to, so the board knows how to
   *  interpret a checkbox click:
   *   - "playbook" (default): each step is an independent PersonalTodo;
   *     clicking one toggles just that item via /api/personal-todos.
   *   - "renewal_stage": `steps` is a fixed 5-item view of the single
   *     `lifecycle_stage` value (Live board's "Renewal" column only,
   *     see renewal-checklist.ts) — clicking item i SETS lifecycle_stage
   *     to that item's label via /api/customer-overrides, and every
   *     item's `completed` is derived fresh from the one current value,
   *     not stored independently. */
  checklist_kind?: "playbook" | "renewal_stage";
  atRisk: { flags: Pick<RiskFlag, "code" | "label">[]; priorityScore: number } | null;
  steps: LifecycleStep[];
  /** "renewal_stage" cards only: the same "Live" ongoing-checklist
   *  todos a Q1/Q2/Q3/Q4 card would show, rendered as a second,
   *  independent group beneath the fixed 5-item renewal checklist —
   *  a Renewal-column account is still "live" day-to-day, so it keeps
   *  a place for ad-hoc ongoing to-dos even while its renewal motion
   *  is tracked separately. Undefined for a "playbook" checklist —
   *  that card's own `steps` already covers the "Live" group. Always
   *  a real (possibly empty) array for a "renewal_stage" card, never
   *  undefined — see buildLiveCard. */
  liveOngoingSteps?: LifecycleStep[];
}

export function atRiskSummary(
  atRiskAccount: AtRiskAccount | undefined
): LifecycleCard["atRisk"] {
  if (!atRiskAccount) return null;
  return {
    flags: atRiskAccount.flags.map((f) => ({ code: f.code, label: f.label })),
    priorityScore: atRiskAccount.priority_score,
  };
}

/** Card sort order for every Lifecycle board column: soonest
 *  `contract_renewal` first. Cards with no contract date (monthly /
 *  never populated in HubSpot) sort last rather than being treated as
 *  "soonest" — an unknown renewal date isn't an urgent one. */
export function compareByRenewalDate(a: LifecycleCard, b: LifecycleCard): number {
  const da = a.customer.contract_renewal;
  const db = b.customer.contract_renewal;
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return da.localeCompare(db);
}

/** Steps that can actually bubble a card up the column or color a
 *  checklist group's header — the ones a CSM would act on today, not
 *  ones already done or intentionally dormant (a future `surface_at`,
 *  same "Scheduled" treatment stage-todo-list.tsx already gives
 *  these). */
function actionableSteps(steps: LifecycleStep[], today: string): LifecycleStep[] {
  return steps.filter((s) => !s.completed && !isScheduledFor(s, today));
}

/** A card's own to-dos, scoped to the array that's actually a "to-do
 *  list" for this purpose. "renewal_stage" cards' own `steps` are the
 *  fixed 5-item renewal checklist (no due dates at all) — their ad-hoc
 *  to-dos live in `liveOngoingSteps` instead. */
function cardTodoSteps(card: LifecycleCard): LifecycleStep[] {
  return card.checklist_kind === "renewal_stage" ? card.liveOngoingSteps ?? [] : card.steps;
}

/** Soonest due date among a set of actionable steps, or undefined if
 *  none of them carry one. */
function earliestDueDate(steps: LifecycleStep[]): string | undefined {
  const dated = steps.filter(
    (s): s is LifecycleStep & { due_date: string } => Boolean(s.due_date)
  );
  if (dated.length === 0) return undefined;
  return dated.reduce((min, s) => (s.due_date < min ? s.due_date : min), dated[0].due_date);
}

type CardUrgency =
  | { tier: 0; dueDate: string }
  | { tier: 1 }
  | { tier: 2 };

/** Sort tier for compareByUrgency: 0 = has an actionable to-do with a
 *  due date (ranked by soonest), 1 = has one but no due date set, 2 =
 *  no actionable to-dos at all. */
function cardUrgency(card: LifecycleCard, today: string): CardUrgency {
  const pending = actionableSteps(cardTodoSteps(card), today);
  if (pending.length === 0) return { tier: 2 };
  const dueDate = earliestDueDate(pending);
  return dueDate ? { tier: 0, dueDate } : { tier: 1 };
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/** Pastel background/border classes for a checklist group's header on
 *  the Live board, banded by how soon its earliest actionable due date
 *  is (overdue / ≤7d / ≤14d / ≤30d) — undefined (unchanged header)
 *  when nothing's actionable or nothing actionable has a due date.
 *  Both light- and dark-mode colors are set explicitly (light bg +
 *  dark:bg-{color}-500/10, not just a text-color swap) so the chip
 *  stays legible with the app's dark mode on — see RiskLevelChip's
 *  "light green" row for the same pattern done right, vs. its
 *  red/yellow/green rows done wrong. */
export function urgencyHeaderClass(
  groupSteps: LifecycleStep[],
  today: string
): string | undefined {
  const dueDate = earliestDueDate(actionableSteps(groupSteps, today));
  if (!dueDate) return undefined;
  const days = daysBetweenYmd(today, dueDate);
  if (days < 0) {
    return "bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30";
  }
  if (days <= 7) {
    return "bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/30";
  }
  if (days <= 14) {
    return "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30";
  }
  if (days <= 30) {
    return "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30";
  }
  return undefined;
}

/** Live board's per-column card order: a card with an actionable to-do
 *  due soon bubbles above one with a due-but-later or no-date to-do,
 *  which in turn bubbles above a card with no actionable to-dos at
 *  all — those (and ties within a tier) fall back to
 *  compareByRenewalDate, same ordering the board used before this
 *  existed. */
export function compareByUrgency(
  a: LifecycleCard,
  b: LifecycleCard,
  now: Date = new Date()
): number {
  const today = todayYmdUtc(now);
  const ua = cardUrgency(a, today);
  const ub = cardUrgency(b, today);
  if (ua.tier !== ub.tier) return ua.tier - ub.tier;
  if (ua.tier === 0 && ub.tier === 0) return ua.dueDate.localeCompare(ub.dueDate);
  return compareByRenewalDate(a, b);
}

export function isEditableBy(
  customer: Customer,
  viewerEmail: string | null | undefined
): boolean {
  return Boolean(
    viewerEmail &&
      customer.customer_success_manager_email &&
      customer.customer_success_manager_email.trim().toLowerCase() ===
        viewerEmail.trim().toLowerCase()
  );
}
