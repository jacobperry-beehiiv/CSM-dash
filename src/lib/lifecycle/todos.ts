import type { Customer } from "@/lib/types";
import type { PersonalTodo } from "@/lib/personal-todos/types";

/** Filters one CSM's full todo list down to the slack-assign playbook
 *  rows (either the onboarding or the live-assignment variant) plus
 *  auto-scheduled live-quarter check-ins, for a single customer,
 *  matched by hubspot_company_id. Shared by the Onboarding and Live
 *  boards — both show the same checklist concept, just whichever
 *  playbook (or auto-scheduled reminder) actually applies to this
 *  customer. */
export function matchPlaybookTodos(
  customer: Customer,
  csmTodos: PersonalTodo[]
): PersonalTodo[] {
  if (!customer.hubspot_company_id) return [];
  return csmTodos.filter(
    (t) =>
      (t.source === "slack_assign" || t.source === "live_quarter_checkin") &&
      t.source_meta?.hubspot_company_id === customer.hubspot_company_id
  );
}

/** Same source/hubspot_company_id check as matchPlaybookTodos, just
 *  without a specific customer to match against — "is this a
 *  company-linked todo at all?" This alone does NOT mean it shows on a
 *  card (the company may have no card, or the card's board may not
 *  render the todo's group) — see isShownOnLifecycleCard in
 *  card-stages.ts for that, which is what the home panel's "Hide
 *  company to-dos" toggle actually uses. */
export function isCompanyGroupedTodo(todo: PersonalTodo): boolean {
  return (
    (todo.source === "slack_assign" || todo.source === "live_quarter_checkin") &&
    Boolean(todo.source_meta?.hubspot_company_id)
  );
}
