/**
 * Client-safe types + defaults for the automated-todo source
 * configuration registry.
 *
 * The engine layer today hard-codes the title string every automated
 * todo fires with — "Kick off renewal for [Company]", "Verify …
 * renewal went through", etc. This registry pulls those into KV so
 * admins can edit the phrasing without a deploy AND wire an
 * "action" (v1: open the outreach modal with a specific template)
 * onto each source. Server-only KV store lives in
 * todo-source-configs.ts.
 *
 * The `source` field on PersonalTodo is the primary key. One config
 * per source — variants (90/60/30/7d milestones etc.) are handled
 * via merge tags on the phrasing template, not separate entries.
 * That's the "one config per source" design decision from the
 * design conversation.
 */

import type { TodoSource } from "../personal-todos/types";

// ─── Which sources are user-facing "automated" ───────────────────────────

/** Sources produced by engines/webhooks (not manually typed). Only
 *  these appear in the settings UI; `manual` stays hidden. `scheduled`
 *  is included because it's engine-created (surface_at scheduling).
 *  Keep in sync with the TodoSource enum. */
export const AUTOMATED_SOURCES = [
  "renewal_milestone",
  "renewal_confirmed",
  "sybill_callrecap",
  "slack_assign",
  "slack_slash",
  "slack_dm",
  "slack_reaction",
  "scheduled",
  "feature_request",
] as const satisfies ReadonlyArray<TodoSource>;

export type AutomatedSource = (typeof AUTOMATED_SOURCES)[number];

// ─── Config shape ────────────────────────────────────────────────────────

export interface TodoSourceConfig {
  /** Handlebars-style title template. Supports these tokens:
   *    - {{company_name}} — customer.company_name ?? workspace_name
   *    - {{milestone_days}} — renewal_milestone only
   *    - {{prior_stage}} — renewal_confirmed only
   *    - {{original_text}} — slack_dm / slack_reaction
   *  Unknown tokens fall through unchanged so a typo doesn't blank a
   *  title.
   */
  phrasing_template: string;
  /** Optional outreach template id to open when the CSM clicks the
   *  todo's action button. When null/empty, no button renders. Must
   *  correspond to a template in the stored-templates KV. */
  linked_template_id: string | null;
  /** Free-form admin note surfaced in the settings UI so the reason
   *  behind the wiring is visible ("using T4/rec pitch template for
   *  90d milestone because that's what Juliet sends first"). Not
   *  shown to the CSM. */
  admin_note?: string | null;
}

export interface TodoSourceConfigsBlob {
  /** Every configured source. Sparse — a missing entry means
   *  "use the shipped default." */
  by_source: Partial<Record<AutomatedSource, TodoSourceConfig>>;
  updated_at?: string;
  updated_by?: string | null;
}

// ─── Human labels for the settings UI ────────────────────────────────────

export const SOURCE_METADATA: Record<
  AutomatedSource,
  {
    label: string;
    description: string;
    /** When true, the settings UI advertises `{{milestone_days}}`
     *  as a supported merge tag alongside the standard ones. */
    supports_milestone: boolean;
    /** When true, the settings UI advertises `{{prior_stage}}`. */
    supports_prior_stage: boolean;
    /** When true, the settings UI advertises `{{original_text}}`. */
    supports_original_text: boolean;
  }
> = {
  renewal_milestone: {
    label: "Renewal milestone (90/60/30/7d)",
    description:
      "Fired by the renewal-milestones sweep when a customer's contract renewal date hits one of the tracked milestones. `{{milestone_days}}` interpolates to the specific day-count.",
    supports_milestone: true,
    supports_prior_stage: false,
    supports_original_text: false,
  },
  renewal_confirmed: {
    label: "Renewal confirmed — verify invoice",
    description:
      "Fired when a customer transitions to the Renewal Confirmed lifecycle stage. `{{prior_stage}}` interpolates to the lifecycle stage they came from.",
    supports_milestone: false,
    supports_prior_stage: true,
    supports_original_text: false,
  },
  sybill_callrecap: {
    label: "Sybill call recap action item",
    description:
      "One todo per action-item bullet parsed from a Sybill call-recap email.",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
  },
  slack_assign: {
    label: "Slack `@bot assign` onboarding step",
    description:
      "Scheduled from the @bot assign onboarding playbook (16 timed steps).",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
  },
  slack_slash: {
    label: "Slack /todo slash command",
    description:
      "Created from Slack via /todo. `{{original_text}}` is the CSM's typed body.",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
  },
  slack_dm: {
    label: "Slack DM to the bot",
    description:
      "Created from a DM to @normbot. `{{original_text}}` is the message body.",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
  },
  slack_reaction: {
    label: "Slack ✅ reaction on a message",
    description:
      "Created when the CSM reacts with the trigger emoji on any Slack message. `{{original_text}}` is the reacted-on message.",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
  },
  scheduled: {
    label: "One-time scheduled todo (surface_at)",
    description:
      "Todo whose surface_at fell into the future when created — surfaces on that date.",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
  },
  feature_request: {
    label: "Feature request handoff",
    description:
      "Auto-created when a feature request is filed and the CSM needs to follow up.",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
  },
};

// ─── Shipped defaults — mirror today's hardcoded strings ─────────────────

export const DEFAULT_TODO_SOURCE_CONFIGS: Record<
  AutomatedSource,
  TodoSourceConfig
> = {
  renewal_milestone: {
    // Original engine string: `Kick off renewal for ${company}`
    phrasing_template: "Kick off renewal for {{company_name}}",
    linked_template_id: null,
  },
  renewal_confirmed: {
    // Original engine string: `Verify ${company} renewal went through`
    phrasing_template: "Verify {{company_name}} renewal went through",
    linked_template_id: null,
  },
  sybill_callrecap: {
    // Sybill titles come straight from the parsed action item; template
    // just echoes the original text.
    phrasing_template: "{{original_text}}",
    linked_template_id: null,
  },
  slack_assign: {
    // The 16-step playbook titles are step-specific; we echo the
    // original title the engine assembled. Kept in the registry so
    // an admin can prepend "@bot: " or similar without a deploy.
    phrasing_template: "{{original_text}}",
    linked_template_id: null,
  },
  slack_slash: {
    phrasing_template: "{{original_text}}",
    linked_template_id: null,
  },
  slack_dm: {
    phrasing_template: "{{original_text}}",
    linked_template_id: null,
  },
  slack_reaction: {
    phrasing_template: "{{original_text}}",
    linked_template_id: null,
  },
  scheduled: {
    phrasing_template: "{{original_text}}",
    linked_template_id: null,
  },
  feature_request: {
    phrasing_template: "{{original_text}}",
    linked_template_id: null,
  },
};

// ─── Effective-config merge helper (defaults + KV overrides) ─────────────

export function mergeTodoSourceConfigs(
  overrides: TodoSourceConfigsBlob | null | undefined
): Record<AutomatedSource, TodoSourceConfig> {
  const out = {} as Record<AutomatedSource, TodoSourceConfig>;
  for (const source of AUTOMATED_SOURCES) {
    const base = DEFAULT_TODO_SOURCE_CONFIGS[source];
    const override = overrides?.by_source?.[source];
    out[source] = { ...base, ...(override ?? {}) };
  }
  return out;
}
