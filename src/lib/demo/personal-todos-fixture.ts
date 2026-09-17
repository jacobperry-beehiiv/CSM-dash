/**
 * Hand-built onboarding/live playbook to-dos for DEMO_MODE, matched to
 * customer-fixture.ts's `hubspot_company_id` values so the Lifecycle
 * tab's Onboarding/Live boards show a fully populated checklist on
 * every card instead of only the handful of seeds someone happened to
 * wire up manually. Mirrors ONBOARDING_PLAYBOOK / LIVE_PLAYBOOK in
 * src/lib/integrations/slack-assign.ts — same step keys, same
 * titles, same "every step exists up front, some just aren't done
 * yet" shape a real `@bot assign` run produces.
 *
 * Progress varies per customer on purpose: a few fully done, a few
 * freshly assigned, most in between, so the Lifecycle boards' column
 * spread and the per-card stage grouping both have real variety to
 * show rather than every card looking the same.
 */

import type { PersonalTodo, PersonalTodosState } from "@/lib/personal-todos/types";

const VIEWER_EMAIL = "demo@beehiiv.com";

/** step_key -> title, onboarding: namespace only. Order matters — it's
 *  the same order ONBOARDING_PLAYBOOK ships them in, and what
 *  `progress` below counts against. */
const ONBOARDING_STEPS: [string, string][] = [
  ["onboarding:confirm_handoff", "Confirm handoff message is complete"],
  [
    "onboarding:no_pkg_sales_timeline",
    "(No-package) Check sales timeline + scope expectations",
  ],
  [
    "onboarding:with_pkg_internal_sync",
    "(With-package) Internal sync — AE + Solutions Engineer + Ashley",
  ],
  ["onboarding:watch_intro_email", "Watch for the CSM intro email from Sales"],
  [
    "onboarding:internal_setup_hubspot",
    "Complete internal setup — verify HubSpot fields",
  ],
  ["onboarding:schedule_kickoff", "Schedule the kickoff call (45-min)"],
  ["onboarding:prep_kickoff", "Prep the kickoff: newsletter breakdown + deck"],
  ["onboarding:run_kickoff", "Run the kickoff call"],
  ["onboarding:post_kickoff", "Post-kickoff follow-up"],
  [
    "onboarding:migration_plan",
    "Build migration plan in Notch + submit CWUP form",
  ],
  ["onboarding:run_training", "Run the training session"],
  [
    "onboarding:post_training",
    "Post-training follow-up + backend asks",
  ],
  ["onboarding:no_pkg_14_day", "(No-package) 14-day check-in email"],
  ["onboarding:no_pkg_30_day", "(No-package) 30-day check-in email"],
  [
    "onboarding:no_pkg_60_day",
    "(No-package) 60-day check-in email + workspace pre-audit",
  ],
  ["onboarding:run_90_day", "Run the 90-day check-in"],
  ["onboarding:post_90_day", "Post-90-day: CSAT + flip HubSpot to Live"],
];

/** step_key -> title, live: namespace (LIVE_PLAYBOOK — accounts
 *  assigned already-live, no onboarding history). */
const LIVE_STEPS: [string, string][] = [
  ["live:get_up_to_speed", "Get up to speed on this account"],
  ["live:intro_call", "Schedule introduction call with main contact"],
  ["live:confirm_drive", "Confirm Drive folder + workspace tracking"],
  ["live:first_30_day", "First 30-day check-in"],
];

interface Profile {
  hubspot_company_id: string;
  playbook: "onboarding" | "live";
  /** How many steps (from the front of the list above) are done. */
  progress: number;
}

/** One entry per customer-fixture.ts seed, matched by hubspot_company_id.
 *  See that file's SEEDS for which company is which. */
const PROFILES: Profile[] = [
  { hubspot_company_id: "hs-demo-001", playbook: "onboarding", progress: 17 },
  { hubspot_company_id: "hs-demo-002", playbook: "onboarding", progress: 17 },
  { hubspot_company_id: "hs-demo-003", playbook: "onboarding", progress: 12 },
  { hubspot_company_id: "hs-demo-004", playbook: "live", progress: 4 },
  { hubspot_company_id: "hs-demo-005", playbook: "live", progress: 2 },
  { hubspot_company_id: "hs-demo-006", playbook: "onboarding", progress: 17 },
  { hubspot_company_id: "hs-demo-007", playbook: "onboarding", progress: 9 },
  { hubspot_company_id: "hs-demo-008", playbook: "live", progress: 4 },
  { hubspot_company_id: "hs-demo-009", playbook: "live", progress: 1 },
  { hubspot_company_id: "hs-demo-010", playbook: "onboarding", progress: 15 },
  { hubspot_company_id: "hs-demo-011", playbook: "onboarding", progress: 17 },
  // Skyline Sundays — the one demo account still mid-onboarding
  // (property_company_status: "Onboarding"). Deliberately mid-stage:
  // Pre-kickoff + Post-kickoff done, Migration & warm-up in progress.
  { hubspot_company_id: "hs-demo-012", playbook: "onboarding", progress: 9 },
  { hubspot_company_id: "hs-demo-013", playbook: "live", progress: 3 },
  { hubspot_company_id: "hs-demo-014", playbook: "live", progress: 0 },
  { hubspot_company_id: "hs-demo-015", playbook: "onboarding", progress: 2 },
];

function buildTodosForProfile(profile: Profile, today: Date): PersonalTodo[] {
  const steps = profile.playbook === "onboarding" ? ONBOARDING_STEPS : LIVE_STEPS;
  const nowIso = today.toISOString();
  return steps.map(([stepKey, title], i) => {
    const completed = i < profile.progress;
    // Due dates spread around the progress point: completed steps due
    // in the past, upcoming ones due in the future — same shape a real
    // playbook's surface/due offsets produce.
    const due = new Date(today);
    due.setUTCDate(due.getUTCDate() + (i - profile.progress + 1) * 4);
    return {
      id: `demo-${profile.hubspot_company_id}-${i}`,
      title,
      details: null,
      due_date: due.toISOString().slice(0, 10),
      surface_at: null,
      priority: "medium",
      source: "slack_assign",
      source_meta: {
        hubspot_company_id: profile.hubspot_company_id,
        playbook_step: stepKey,
      },
      completed_at: completed ? nowIso : null,
      created_at: nowIso,
      updated_at: nowIso,
    };
  });
}

/** Compute the full demo to-do state at request time. Lazy on `today`
 *  for the same SSR-snapshot-safety reason customer-fixture.ts is. */
export function buildDemoPersonalTodos(today: Date = new Date()): PersonalTodosState {
  const todos = PROFILES.flatMap((p) => buildTodosForProfile(p, today));
  return { by_user: { [VIEWER_EMAIL]: { todos } } };
}
