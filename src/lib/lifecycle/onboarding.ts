import type { AtRiskAccount, Customer } from "@/lib/types";
import type { PersonalTodo } from "@/lib/personal-todos/types";
import { daysUntilRenewal } from "@/lib/renewals/date";
import { matchPlaybookTodos } from "./todos";
import { resolvePlaybookStepKey } from "./step-stage-config";
import { atRiskSummary, isEditableBy, type LifecycleCard } from "./card";

/**
 * Lifecycle tab — Onboarding board. Manual, drag-and-drop, backed by
 * the `onboarding_lifecycle_stage` override (customer-overrides.ts) —
 * dragging a card is what changes it, nothing here recomputes it
 * live. The one exception is `suggestOnboardingStage`: a one-time
 * best guess used only before a customer has ever been placed — see
 * onboarding-board.tsx for how the suggestion gets persisted (a
 * client-triggered write, not a live recomputation).
 *
 * Deliberately independent of src/lib/data/settings-types.ts's
 * DEFAULT_LIFECYCLE_STAGES / the `lifecycle_stage` override — those
 * back the AM team's Renewals-tab dropdown (and the Live board's
 * "Renewal" column, which reuses that field verbatim). Never confuse
 * the two.
 *
 * Which step's checklist item shows on THIS board (vs Live) is driven
 * entirely by its CONFIGURED stage (settings.lifecycle_step_stages,
 * see step-stage-config.ts) — a step assigned to one of
 * ONBOARDING_ASSIGNABLE_STAGES shows here, regardless of whether
 * Normbot originally handed it out via the onboarding or live flow.
 * That's what lets an admin move a step between boards at
 * /settings/lifecycle-steps. The one exception is
 * `hasLivePlaybookTodos` below — that's a graduation *signal* (did
 * Normbot assign this account via the Live flow at all), an immutable
 * fact about assignment origin, so it deliberately keeps checking the
 * raw `live:` step_key prefix instead of the configurable stage.
 */

/** Onboarding board's fixed column list. Deliberately hardcoded, not
 *  settings-configurable — renaming/adding a stage here doesn't just
 *  relabel a column, it changes what a step's configured stage
 *  (settings.lifecycle_step_stages) can validly point to, so it's not
 *  the kind of freeform list a settings text field can safely drive.
 *  "Launch" is the terminal stage — reaching it hands the customer
 *  off to the Live board. */
export const ONBOARDING_STAGES = [
  "Pre-kickoff",
  "Post-kickoff",
  "Migration & warm-up",
  "Launch",
];

/** Columns an individual onboarding: step can be assigned to at
 *  /settings/lifecycle-steps. Excludes "Launch" — that's the terminal
 *  state reached when every step is done, never a step's own target. */
export const ONBOARDING_ASSIGNABLE_STAGES = ONBOARDING_STAGES.filter(
  (s) => s !== "Launch"
);

/** Matches the renewal-milestones engine's own forward window
 *  (src/lib/engines/renewal-milestones.ts MILESTONES = [90, 60, 30, 7])
 *  so "already renewing" here lines up with when that engine starts
 *  pinging. */
const RENEWAL_WINDOW_DAYS = 90;

function isChurnLike(customer: Customer): boolean {
  const status = (customer.property_company_status ?? "").toLowerCase();
  const engagement = (customer.company_engagement ?? "").toLowerCase();
  return status.includes("churn") || engagement.includes("churn");
}

function isInRenewalMotion(
  customer: Customer,
  lifecycleStageOverride: string | null | undefined,
  now: Date
): boolean {
  if (lifecycleStageOverride && lifecycleStageOverride.trim()) return true;
  const days = daysUntilRenewal(customer.contract_renewal ?? null, now);
  return days != null && days >= 0 && days <= RENEWAL_WINDOW_DAYS;
}

function onboardingTodosOf(
  matchedTodos: PersonalTodo[],
  stepStages: Record<string, string | null>
): PersonalTodo[] {
  return matchedTodos.filter((t) => {
    const stage = stepStages[resolvePlaybookStepKey(t) ?? ""];
    return stage != null && ONBOARDING_ASSIGNABLE_STAGES.includes(stage);
  });
}

function hasLivePlaybookTodos(matchedTodos: PersonalTodo[]): boolean {
  return matchedTodos.some((t) => resolvePlaybookStepKey(t)?.startsWith("live:"));
}

/** This board's checklist, soonest due date first (nulls last) —
 *  matches the Live board's own ordering (live-quarter.ts), rather
 *  than the fixed playbook sequence a step originated from. */
function orderedOnboardingTodos(
  matchedTodos: PersonalTodo[],
  stepStages: Record<string, string | null>
): PersonalTodo[] {
  return [...onboardingTodosOf(matchedTodos, stepStages)].sort((a, b) => {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date);
  });
}

/**
 * True once a customer has clearly graduated onboarding by signals
 * OTHER than an explicit `onboarding_lifecycle_stage` override
 * (churn, already in the renewal motion, HubSpot status already
 * "Live", or — the account was assigned via the "Live" flow in Slack,
 * so it never had an onboarding playbook at all). Used to decide
 * whether an unplaced customer belongs on the Onboarding board or the
 * Live board; an explicit override always takes precedence over this
 * (see buildOnboardingCard / the page branch that calls this).
 */
export function hasGraduatedOnboarding(
  customer: Customer,
  matchedTodos: PersonalTodo[],
  lifecycleStageOverride: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (isChurnLike(customer)) return true;
  if (isInRenewalMotion(customer, lifecycleStageOverride, now)) return true;
  if ((customer.property_company_status ?? "").toLowerCase() === "live") {
    return true;
  }
  if (hasLivePlaybookTodos(matchedTodos)) return true;
  return false;
}

/** One-time best guess for a customer who has never been manually
 *  placed. Only ever returns a label from ONBOARDING_STAGES (or null)
 *  — the caller discards the result if it isn't a currently-valid
 *  column. `stepStages` is the admin-configured step->stage map
 *  (already defaulted — see resolveLifecycleStepStages), so a
 *  reassigned step immediately changes where an unplaced card lands. */
function suggestOnboardingStage(
  matchedTodos: PersonalTodo[],
  stepStages: Record<string, string | null>
): string | null {
  const ordered = orderedOnboardingTodos(matchedTodos, stepStages);
  if (ordered.length === 0) return null;
  const firstOpen = ordered.find((t) => !t.completed_at);
  if (!firstOpen) return "Launch";
  const stepKey = resolvePlaybookStepKey(firstOpen) ?? "";
  return stepStages[stepKey] ?? null;
}

export function buildOnboardingCard(
  customer: Customer & { workspace_id: string },
  csmTodos: PersonalTodo[],
  onboardingStageOverride: string | null | undefined,
  configuredStages: string[],
  stepStages: Record<string, string | null>,
  atRiskAccount: AtRiskAccount | undefined,
  viewerEmail: string | null | undefined
): LifecycleCard {
  const matched = matchPlaybookTodos(customer, csmTodos);
  const ordered = orderedOnboardingTodos(matched, stepStages);
  const completedCount = ordered.filter((t) => t.completed_at).length;
  const totalCount = ordered.length;

  const persisted = onboardingStageOverride?.trim() || null;
  const persistedIsValid = persisted != null && configuredStages.includes(persisted);

  let suggested: string | null = null;
  if (!persistedIsValid) {
    const candidate = suggestOnboardingStage(matched, stepStages);
    suggested = candidate && configuredStages.includes(candidate) ? candidate : null;
  }

  return {
    customer,
    stage: persistedIsValid ? persisted : null,
    suggested_stage: suggested,
    completedCount,
    totalCount,
    editable: isEditableBy(customer, viewerEmail),
    atRisk: atRiskSummary(atRiskAccount),
    steps: ordered.map((t) => ({
      id: t.id,
      title: t.title,
      completed: Boolean(t.completed_at),
      due_date: t.due_date,
      stage: stepStages[resolvePlaybookStepKey(t) ?? ""] ?? null,
      details: t.details,
    })),
  };
}
