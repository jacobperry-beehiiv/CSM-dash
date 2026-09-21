import {
  ONBOARDING_PLAYBOOK,
  LIVE_PLAYBOOK,
} from "../integrations/playbook-templates";

/**
 * Canonical list of every playbook step the Lifecycle tab's Onboarding
 * and Live boards can show a checklist item for. step_key/title are
 * read straight from ONBOARDING_PLAYBOOK / LIVE_PLAYBOOK in
 * src/lib/integrations/playbook-templates.ts — the same list the Slack
 * "@bot assign" flow (Normbot) actually hands a CSM — so this can never
 * drift out of sync with what Normbot assigns. If that file grows a new
 * step, it shows up here automatically.
 *
 * `playbook` reflects which array a step originated from (Normbot's
 * "flow"), purely for the settings page's default grouping — it does
 * NOT constrain which board column a step can be assigned to. See
 * onboarding.ts / live-quarter.ts: which board actually renders a
 * step's checklist item is governed entirely by its CONFIGURED stage
 * (below), so reassigning a step to the other board's columns at
 * /settings/lifecycle-steps really does move it there.
 *
 * Which column each step defaults to is admin-editable at
 * /settings/lifecycle-steps (settings.lifecycle_step_stages), unlike
 * the boards' own column lists (ONBOARDING_STAGES in onboarding.ts,
 * LIVE_ASSIGNABLE_STAGES in live-quarter.ts), which are fixed — see
 * that page's own explanation for why the split works this way.
 */

export interface PlaybookStepInfo {
  step_key: string;
  title: string;
  /** The template's own body text — same field @bot assign copies
   *  verbatim into a real todo's `details`. Carried here so a
   *  manually-created one-off todo (see personal-todos-panel.tsx's
   *  playbook-step picker) can pre-fill the same context text instead
   *  of shipping with nothing. */
  details: string;
  /** Which Normbot flow this step came from — default grouping only,
   *  not a constraint (see module doc comment). */
  playbook: "onboarding" | "live";
  /** Column this step is tagged with until an admin reassigns it.
   *  `null` means "no known default" — a step Normbot's playbook grew
   *  after this list was last hand-mapped. Surfaces as "Unassigned" at
   *  /settings/lifecycle-steps until someone picks a column for it,
   *  rather than silently defaulting or being dropped. */
  default_stage: string | null;
}

/** Hand-maintained defaults for the steps that existed when this board
 *  shipped. Deliberately NOT auto-derived from playbook order — a
 *  step's position in the sequence doesn't reliably imply which board
 *  column it belongs to. A step_key missing from this map (any step
 *  playbook-templates.ts grows later) resolves to `null` below. */
const KNOWN_DEFAULT_STAGES: Record<string, string> = {
  "onboarding:confirm_handoff": "Pre-kickoff",
  "onboarding:no_pkg_sales_timeline": "Pre-kickoff",
  "onboarding:with_pkg_internal_sync": "Pre-kickoff",
  "onboarding:watch_intro_email": "Pre-kickoff",
  "onboarding:internal_setup_hubspot": "Pre-kickoff",
  "onboarding:schedule_kickoff": "Pre-kickoff",
  "onboarding:prep_kickoff": "Pre-kickoff",
  "onboarding:run_kickoff": "Pre-kickoff",
  "onboarding:post_kickoff": "Post-kickoff",
  "onboarding:migration_plan": "Migration & warm-up",
  "onboarding:run_training": "Migration & warm-up",
  "onboarding:post_training": "Migration & warm-up",
  "onboarding:no_pkg_14_day": "Migration & warm-up",
  "onboarding:no_pkg_30_day": "Migration & warm-up",
  "onboarding:no_pkg_60_day": "Migration & warm-up",
  "onboarding:run_90_day": "Migration & warm-up",
  "onboarding:post_90_day": "Migration & warm-up",
  "live:get_up_to_speed": "Q1",
  "live:intro_call": "Q1",
  "live:confirm_drive": "Q1",
  "live:first_30_day": "Q1",
};

export const PLAYBOOK_STEPS: PlaybookStepInfo[] = [
  ...ONBOARDING_PLAYBOOK.map((t) => ({
    step_key: t.step_key,
    title: t.title,
    details: t.details,
    playbook: "onboarding" as const,
    default_stage: KNOWN_DEFAULT_STAGES[t.step_key] ?? null,
  })),
  ...LIVE_PLAYBOOK.map((t) => ({
    step_key: t.step_key,
    title: t.title,
    details: t.details,
    playbook: "live" as const,
    default_stage: KNOWN_DEFAULT_STAGES[t.step_key] ?? null,
  })),
];

export const DEFAULT_LIFECYCLE_STEP_STAGES: Record<string, string | null> =
  Object.fromEntries(PLAYBOOK_STEPS.map((s) => [s.step_key, s.default_stage]));

/** Hydrate the configured step->stage map for use by the board
 *  builders and the settings editor alike — stored overrides layer on
 *  top of the defaults so a partial save (or none at all) never leaves
 *  a *known* step unaccounted for. A step with no default AND no
 *  stored override resolves to `null` — "Unassigned" — rather than a
 *  guessed column. */
export function resolveLifecycleStepStages(
  stored: Record<string, string | null> | undefined
): Record<string, string | null> {
  return { ...DEFAULT_LIFECYCLE_STEP_STAGES, ...(stored ?? {}) };
}

/** step title -> step_key, for recovering a step_key from a todo that
 *  has no `source_meta.playbook_step` at all — see
 *  resolvePlaybookStepKey below. */
const TITLE_TO_STEP_KEY: Record<string, string> = Object.fromEntries(
  PLAYBOOK_STEPS.map((s) => [s.title, s.step_key])
);

/**
 * Recovers a playbook todo's step_key when `source_meta.playbook_step`
 * is missing entirely — true for any @bot-assign batch created before
 * that field was added to slack-assign.ts's buildAssignTodoSequence;
 * there was no backfill migration for pre-existing data, so those
 * todos match fine by hubspot_company_id but silently vanish from the
 * board once the stage lookup can't resolve a key for them (found via
 * a real customer's fully-missing checklist — see the git history for
 * this function).
 *
 * Falls back to matching the todo's title against the known playbook
 * step titles, stripping the "{company} — " prefix
 * buildAssignTodoSequence always adds (titles are stable identifiers
 * even when step_key metadata is missing; company names aren't, so we
 * match on the suffix after the FIRST " — ", not a prefix match
 * against the customer's current name). Deliberately the first
 * occurrence, not the last — a couple of real step titles (e.g.
 * "(With-package) Internal sync — AE + Solutions Engineer + Ashley")
 * contain their own " — ", and the company-name prefix is always
 * exactly one, prepended once at the very start. Returns null when
 * neither the stored key nor a title match resolves — e.g. the CSM
 * has since renamed the todo, or it was never a playbook step to
 * begin with.
 */
export function resolvePlaybookStepKey(todo: {
  title: string;
  source_meta?: { playbook_step?: string | null } | null;
}): string | null {
  const stored = todo.source_meta?.playbook_step;
  if (stored) return stored;
  if (TITLE_TO_STEP_KEY[todo.title]) return TITLE_TO_STEP_KEY[todo.title];
  const sepIndex = todo.title.indexOf(" — ");
  const stepTitle = sepIndex >= 0 ? todo.title.slice(sepIndex + 3) : todo.title;
  return TITLE_TO_STEP_KEY[stepTitle] ?? null;
}

/**
 * A todo's effective Lifecycle board grouping — tries, in order:
 *   1. `source_meta.checklist_group`, set directly at creation time
 *      for a manually-created one-off todo (personal-todos-panel.tsx's
 *      checklist-group picker). Not a playbook_step at all, so it
 *      skips the lookup below entirely.
 *   2. The usual playbook_step -> configured-stage lookup (real
 *      playbook steps, including ones recovered via
 *      resolvePlaybookStepKey's title-matching fallback).
 * Returns null when neither resolves — the caller treats that the
 * same as "no known grouping" either way. */
export function resolveTodoStage(
  todo: {
    title: string;
    source_meta?: {
      playbook_step?: string | null;
      checklist_group?: string | null;
    } | null;
  },
  stepStages: Record<string, string | null>
): string | null {
  const direct = todo.source_meta?.checklist_group;
  if (direct) return direct;
  return stepStages[resolvePlaybookStepKey(todo) ?? ""] ?? null;
}
