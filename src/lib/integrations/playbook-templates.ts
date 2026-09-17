/**
 * Single source of truth for the onboarding/live to-do sequences the
 * Slack "@bot assign" flow (Normbot) hands a CSM when an account is
 * assigned. Pulled out of slack-assign.ts so it has zero server-only
 * imports — src/lib/lifecycle/step-stage-config.ts (which needs to be
 * safe for a "use client" settings editor to import) reads the exact
 * same step_key/title list, instead of maintaining a hand-copied
 * mirror that could drift out of sync with what Normbot actually
 * assigns. slack-assign.ts imports these arrays too, unchanged from
 * before this split — this file only relocates them.
 */

export interface TodoTemplate {
  /** Stable identifier for this step. Used as the variant key on the
   *  todo-source-configs registry so admins can bind a different
   *  outreach template per step. Never renumber existing keys —
   *  changing a step's key strands any existing action-binding at
   *  /settings/todo-automation, and disconnects it from any column
   *  assignment already saved at /settings/lifecycle-steps. Add/remove
   *  is fine; keys are optional bindings anyway. */
  step_key: string;
  title: string;
  details: string;
  /** Days from today to hide the to-do until. 0 = visible immediately.
   *  Lets a 90-day playbook land all at once without flooding the CSM's
   *  list — items show up as they become relevant. */
  surface_offset_days: number;
  /** Days from today the to-do is due. */
  due_offset_days: number;
}

/** Onboarding playbook — full ~90-day sequence. Mirrors the CSM team's
 *  onboarding doc; each title/details pair is the operational substance
 *  of one step. */
export const ONBOARDING_PLAYBOOK: TodoTemplate[] = [
  {
    step_key: "onboarding:confirm_handoff",
    title: "Confirm handoff message is complete",
    details:
      "Verify the AE's #topic-enterprise-customers post has: HubSpot link, subscriber tier + billing cadence, workspace owner email, timezone, touch level, Stripe ID, enablement survey link, deliverability info screenshot, package status, Solutions Engineer involvement. Ask the AE if anything's missing.",
    surface_offset_days: 0,
    due_offset_days: 1,
  },
  {
    step_key: "onboarding:no_pkg_sales_timeline",
    title: "(No-package) Check sales timeline + scope expectations",
    details:
      "Check HubSpot or ask the AE when the sales process started. Before March 2026 + needs extra support → flag internally, consider free Solutions work or expert directory. After March 2026 + needs extra support → flag with AE to confirm opt-out and resell if needed. Keep CSM scope in mind: guided launch plan, one live platform orientation, ad-hoc ongoing support.",
    surface_offset_days: 0,
    due_offset_days: 2,
  },
  {
    step_key: "onboarding:with_pkg_internal_sync",
    title: "(With-package) Internal sync — AE + Solutions Engineer + Ashley",
    details:
      "15-min pre-kickoff sync. Cover sales context, customer expectations, kickoff attendees, plan questions.",
    surface_offset_days: 1,
    due_offset_days: 3,
  },
  {
    step_key: "onboarding:watch_intro_email",
    title: "Watch for the CSM intro email from Sales",
    details:
      "Sales sends the email introducing you to the customer. Reply when it lands to book the kickoff.",
    surface_offset_days: 1,
    due_offset_days: 3,
  },
  {
    step_key: "onboarding:internal_setup_hubspot",
    title: "Complete internal setup — verify HubSpot fields",
    details:
      "Drive folder is auto-created by @bot assign. Confirm HubSpot company has: company engagement, owner email, Stripe customer ID, main contact, renewal date (if annual).",
    surface_offset_days: 1,
    due_offset_days: 3,
  },
  {
    step_key: "onboarding:schedule_kickoff",
    title: "Schedule the kickoff call (45-min)",
    details:
      "Reply to Sales intro email with the kickoff email template. Add Ashley Hays (and anyone else from beehiiv who needs to join) — reference her calendar. Set agenda on the invite.",
    surface_offset_days: 2,
    due_offset_days: 5,
  },
  {
    step_key: "onboarding:prep_kickoff",
    title: "Prep the kickoff: newsletter breakdown + deck",
    details:
      "Save newsletter breakdown spreadsheet to the customer folder + fill it in (or plan for the customer to complete). Save and update the kickoff deck. (With-package) Align with Ashley on her portion of the deck.",
    surface_offset_days: 4,
    due_offset_days: 7,
  },
  {
    step_key: "onboarding:run_kickoff",
    title: "Run the kickoff call",
    details:
      "Walk through the kickoff deck — align on migration process, goals/challenges, ongoing support model.",
    surface_offset_days: 6,
    due_offset_days: 8,
  },
  {
    step_key: "onboarding:post_kickoff",
    title: "Post-kickoff follow-up",
    details:
      "Email the customer (attach kickoff deck, send newsletter breakdown spreadsheet if they need to fill it, and schedule the ~1-hour training session). Update HubSpot with customer goals and apply contact labels (billing, main, enterprise roadmap invite, priority).",
    surface_offset_days: 8,
    due_offset_days: 9,
  },
  {
    step_key: "onboarding:migration_plan",
    title: "Build migration plan in Notch + submit CWUP form",
    details:
      "With-package: get the Notch link from Ashley. No-package: copy the CSM ENT onboarding Notch template. Update Overview tab (team, goals, kickoff deck PDF, newsletter breakdown). Submit the New Customer Warm Up Schedule form (Mac builds the CWUP, 1-3 business days; DNC or a template substitute if Mac is out), then link CWUP under the Migration tab.",
    surface_offset_days: 9,
    due_offset_days: 14,
  },
  {
    step_key: "onboarding:run_training",
    title: "Run the training session",
    details:
      "Confirm the migration plan is complete (review past walkthrough recordings if needed). On the call: present the migration plan, give a high-level platform walkthrough focused on launch, offer growth/monetization strategy sessions, and mention the upcoming 90-day check-in.",
    surface_offset_days: 14,
    due_offset_days: 21,
  },
  {
    step_key: "onboarding:post_training",
    title: "Post-training follow-up + backend asks",
    details:
      "Email the customer (recording, migration plan, 30-min 90-day check-in availability). Update Notch Training & Resources tab. Post in #topic-email-deliverability to move publication(s) to the medium IP pool (include pub IDs). Post in #ent-ad-network-tiers to assign an Ad Network tier (publisher name, publisher ID, MRR, tier rec 1–3, likelihood of complaining).",
    surface_offset_days: 21,
    due_offset_days: 22,
  },
  {
    step_key: "onboarding:no_pkg_14_day",
    title: "(No-package) 14-day check-in email",
    details:
      "Light-touch check-in. High-touch customers: bump to weekly/bi-weekly cadence instead.",
    surface_offset_days: 12,
    due_offset_days: 15,
  },
  {
    step_key: "onboarding:no_pkg_30_day",
    title: "(No-package) 30-day check-in email",
    details: "Check progress against the migration plan. Surface blockers early.",
    surface_offset_days: 28,
    due_offset_days: 32,
  },
  {
    step_key: "onboarding:no_pkg_60_day",
    title: "(No-package) 60-day check-in email + workspace pre-audit",
    details:
      "Email check-in. Audit the workspace before the 90-day call lands.",
    surface_offset_days: 58,
    due_offset_days: 62,
  },
  {
    step_key: "onboarding:run_90_day",
    title: "Run the 90-day check-in",
    details:
      "Audit the workspace via the CSM dashboard. Copy the beehiiv utilization spreadsheet to the customer folder and link it on the Notch 90 Day Check In tab. (No-package) Confirm Notch Account Setup steps are done. On the call: review the spreadsheet, revisit goals, ask for a referral (mention the partner program).",
    surface_offset_days: 85,
    due_offset_days: 90,
  },
  {
    step_key: "onboarding:post_90_day",
    title: "Post-90-day: CSAT + flip HubSpot to Live",
    details:
      "Send the 90-day CSAT survey. Update HubSpot: risk level (re-evaluate), company engagement, status → Live.",
    surface_offset_days: 90,
    due_offset_days: 91,
  },
];

/** Shorter sequence for accounts assigned as Live (already past
 *  onboarding — the new CSM just needs to get up to speed). */
export const LIVE_PLAYBOOK: TodoTemplate[] = [
  {
    step_key: "live:get_up_to_speed",
    title: "Get up to speed on this account",
    details:
      "Read the HubSpot company record (recent notes, deal history, contact list). Skim the dashboard's customer detail panel for last-send, deliverability, and risk signals.",
    surface_offset_days: 0,
    due_offset_days: 2,
  },
  {
    step_key: "live:intro_call",
    title: "Schedule introduction call with main contact",
    details:
      "Send a brief intro email and book a 30-min call. If they have a renewal coming up, reference the annual renewal process.",
    surface_offset_days: 1,
    due_offset_days: 5,
  },
  {
    step_key: "live:confirm_drive",
    title: "Confirm Drive folder + workspace tracking",
    details:
      "Drive folder is auto-created by @bot assign. Make sure any historical notes/decks from the previous CSM are saved there.",
    surface_offset_days: 0,
    due_offset_days: 3,
  },
  {
    step_key: "live:first_30_day",
    title: "First 30-day check-in",
    details:
      "Light-touch email check-in. Confirm relationship health, surface blockers.",
    surface_offset_days: 28,
    due_offset_days: 32,
  },
];
