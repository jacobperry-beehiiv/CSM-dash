import type { AtRiskAccount, Customer, RiskFlag } from "@/lib/types";

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
