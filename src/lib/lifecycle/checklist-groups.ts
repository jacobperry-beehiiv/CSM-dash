import { ONBOARDING_ASSIGNABLE_STAGES } from "./onboarding";
import { LIVE_ONGOING_GROUP } from "./live-quarter";

/**
 * The Lifecycle board's real checklist groupings, in one place —
 * shared by every "assign a manually-created todo to a group" picker
 * (personal-todos-panel.tsx's composer, add-todo-modal.tsx's on-card
 * "+"). Always all 4, regardless of which company/board is in
 * context — few enough that filtering by board wouldn't be worth the
 * complexity (see resolveTodoStage in step-stage-config.ts for how a
 * todo tagged with one of these actually lands on the right card).
 */
export interface ChecklistGroupOption {
  value: string;
  section: "Onboarding" | "Live";
}

export const CHECKLIST_GROUP_OPTIONS: ChecklistGroupOption[] = [
  ...ONBOARDING_ASSIGNABLE_STAGES.map((s) => ({ value: s, section: "Onboarding" as const })),
  { value: LIVE_ONGOING_GROUP, section: "Live" as const },
];
