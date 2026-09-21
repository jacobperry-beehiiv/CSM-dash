/**
 * Friendlier display text for a handful of stage / checklist-group
 * values, WITHOUT renaming the values themselves.
 *
 * "Migration & warm-up" and "Live" (LIVE_ONGOING_GROUP) aren't just
 * column headers — they're the literal strings persisted in
 * customer-overrides.onboarding_lifecycle_stage (a customer manually
 * placed in that column), settings.lifecycle_step_stages (an admin's
 * /settings/lifecycle-steps reassignment), and
 * PersonalTodo.source_meta.checklist_group (every "Live"-tagged
 * to-do, including the ones the live-quarter-checkins engine already
 * auto-created on the real preview). Renaming those constants outright
 * would silently orphan any of that already-persisted data — a card
 * would fall out of its column, a todo would stop resolving to a
 * group — the next time it's read back and compared against the
 * renamed constant.
 *
 * So the values stay exactly as they are everywhere they're stored or
 * matched; this map only changes what gets rendered as text, at each
 * of the handful of places a stage value is shown to a CSM (column
 * headers, checklist-group headers, the "+" composer's group picker,
 * /settings/lifecycle-steps). Reads a display label; storage/matching
 * code should never touch this file.
 */
const STAGE_DISPLAY_LABELS: Record<string, string> = {
  "Migration & warm-up": "Migrating",
  Live: "To-do",
};

export function stageDisplayLabel(stage: string): string {
  return STAGE_DISPLAY_LABELS[stage] ?? stage;
}
