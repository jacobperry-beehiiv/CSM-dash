import type { Customer } from "@/lib/types";
import type { PersonalTodo } from "@/lib/personal-todos/types";
import { isCompanyGroupedTodo } from "./todos";
import { isOnOnboardingBoard, ONBOARDING_ASSIGNABLE_STAGES } from "./onboarding";
import {
  computeLiveQuarter,
  LIVE_ASSIGNABLE_STAGES,
  LIVE_ONGOING_GROUP,
} from "./live-quarter";
import { resolveTodoStage } from "./step-stage-config";

/**
 * "Would this to-do actually be visible on a Lifecycle card?" — the
 * question behind the home panel's "Hide company to-dos" toggle.
 *
 * Being linked to a company isn't enough. A to-do only renders on a
 * card when (a) that company has a card on the viewer's own board, and
 * (b) the to-do's resolved group is one the card's board shows: an
 * Onboarding card shows only the onboarding groups, a Live card shows
 * Live/Q1/Q2/Q3, and a card in the Renewal column shows only the "Live"
 * group (its fixed renewal checklist replaces the rest). A to-do that
 * fails either test has no home on any card, so the toggle must leave
 * it in "Your to-dos" — otherwise it's invisible everywhere.
 *
 * Split in two so the server can do the expensive half once per page
 * load (which customers/boards/columns exist) and the client can do
 * the cheap half per to-do, including ones added after load.
 */

/** hubspot_company_id → the checklist groups that company's card(s)
 *  render. Plain JSON so it crosses the server→client boundary. */
export type CardStagesByCompany = Record<string, string[]>;

/** Which checklist groups this customer's card renders, given the
 *  board it's on. Mirrors buildOnboardingCard / buildLiveCard's own
 *  filtering — change one, change the other. */
export function stagesShownOnCard(
  customer: Customer,
  csmTodos: PersonalTodo[],
  override: Parameters<typeof isOnOnboardingBoard>[2],
  now: Date = new Date()
): string[] {
  if (isOnOnboardingBoard(customer, csmTodos, override, now)) {
    return ONBOARDING_ASSIGNABLE_STAGES;
  }
  return computeLiveQuarter(customer, now) === "Renewal"
    ? [LIVE_ONGOING_GROUP]
    : LIVE_ASSIGNABLE_STAGES;
}

/** Server half. `customers` must already be the viewer's own book —
 *  the customers whose card renders the viewer's to-dos — each with a
 *  workspace_id (no id, no card). Several customers can share one
 *  HubSpot company; a to-do is on a card if ANY of them shows it. */
export function buildCardStagesByCompany(
  customers: Customer[],
  csmTodos: PersonalTodo[],
  overrides: Record<string, Parameters<typeof isOnOnboardingBoard>[2]>,
  now: Date = new Date()
): CardStagesByCompany {
  const out: Record<string, Set<string>> = {};
  for (const c of customers) {
    if (!c.workspace_id || !c.hubspot_company_id) continue;
    const stages = stagesShownOnCard(c, csmTodos, overrides[c.workspace_id], now);
    const set = (out[c.hubspot_company_id] ??= new Set());
    for (const s of stages) set.add(s);
  }
  return Object.fromEntries(
    Object.entries(out).map(([id, set]) => [id, [...set]])
  );
}

/** Client half. */
export function isShownOnLifecycleCard(
  todo: PersonalTodo,
  cardStagesByCompany: CardStagesByCompany,
  stepStages: Record<string, string | null>
): boolean {
  if (!isCompanyGroupedTodo(todo)) return false;
  const stages = cardStagesByCompany[todo.source_meta?.hubspot_company_id ?? ""];
  if (!stages) return false;
  const stage = resolveTodoStage(todo, stepStages);
  return stage != null && stages.includes(stage);
}
