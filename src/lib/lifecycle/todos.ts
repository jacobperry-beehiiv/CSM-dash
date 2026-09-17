import type { Customer } from "@/lib/types";
import type { PersonalTodo } from "@/lib/personal-todos/types";

/** Filters one CSM's full todo list down to the slack-assign playbook
 *  rows (either the onboarding or the live-assignment variant) for a
 *  single customer, matched by hubspot_company_id. Shared by the
 *  Onboarding and Live boards — both show the same checklist concept,
 *  just whichever playbook actually applies to this customer. */
export function matchPlaybookTodos(
  customer: Customer,
  csmTodos: PersonalTodo[]
): PersonalTodo[] {
  if (!customer.hubspot_company_id) return [];
  return csmTodos.filter(
    (t) =>
      t.source === "slack_assign" &&
      t.source_meta?.hubspot_company_id === customer.hubspot_company_id
  );
}
