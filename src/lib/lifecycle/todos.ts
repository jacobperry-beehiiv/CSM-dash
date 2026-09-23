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
 *  without a specific customer to match against — "would this todo
 *  show up on SOME Lifecycle board card's checklist?" rather than "on
 *  THIS one's." Used by personal-todos-panel.tsx's "Hide company
 *  to-dos" toggle: a todo this returns true for already has a home on
 *  the Lifecycle board, so hiding it there is meant to make "Your
 *  to-dos" the CSM's place for everything that ISN'T tracked on a
 *  company's card (renewal-milestone pings, Slack DMs, plain manual
 *  todos with no company attached, etc. all stay visible either way). */
export function isCompanyGroupedTodo(todo: PersonalTodo): boolean {
  return (
    (todo.source === "slack_assign" || todo.source === "live_quarter_checkin") &&
    Boolean(todo.source_meta?.hubspot_company_id)
  );
}
