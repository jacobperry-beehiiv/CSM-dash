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

/** Action bound to a todo source (or variant of one). Tagged union so
 *  the settings editor and the runtime button can branch on `kind`
 *  without extra flags.
 *
 *   - `none`  → panel renders no button at all.
 *   - `email` → panel renders "✉︎ Draft outreach"; click opens the
 *               outreach modal with `template_id` pre-selected. Same
 *               shape as v1 of this registry.
 *   - `slack` → panel renders "📣 Send Slack"; click posts
 *               `message_template` (after merge-tag substitution) to
 *               `channel_id` via the app's bot user. `channel_id`
 *               matches SLACK_CHANNEL_ID_RE (`C…`/`G…` etc.); no
 *               name-to-id resolution here.
 */
export type TodoAction =
  | { kind: "none" }
  | { kind: "email"; template_id: string }
  | { kind: "slack"; channel_id: string; message_template: string };

/** Cap for Slack action `message_template`. Slack itself accepts up to
 *  40k chars per message; we cap well below so a fat-fingered paste
 *  can't blow the KV blob size, and any admin who legitimately needs
 *  a long template can still fit a reasonable pitch + merge tags. */
export const SLACK_CHANNEL_MSG_MAX_LEN = 4000;

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
  /** Action taken when the CSM clicks the panel button on a todo of
   *  this source AND no matching per-variant entry exists in
   *  `action_by_variant`. `{ kind: "none" }` means no button at all. */
  default_action: TodoAction;
  /** Per-variant action bindings for sources that fire in variants
   *  (renewal_milestone at 90/60/30/7d, slack_assign per playbook
   *  step, …). Keys are the variant string — for renewal_milestone
   *  that's `String(source_meta.milestone_days)`; for slack_assign
   *  it's the step slug. When a todo's variant appears here, the
   *  panel action button uses that entry. When absent, falls back to
   *  `default_action`. Empty map = no per-variant bindings. */
  action_by_variant?: Record<string, TodoAction>;
  /** Free-form admin note surfaced in the settings UI so the reason
   *  behind the wiring is visible ("using T4/rec pitch template for
   *  90d milestone because that's what Juliet sends first"). Not
   *  shown to the CSM. */
  admin_note?: string | null;

  /** Default offset (in whole days) applied to the todo's `due_date`
   *  relative to whatever anchor the source's engine uses. For
   *  `renewal_milestone` the anchor is the milestone date itself, so
   *  `+0` means "due on the day", `-3` means "due three days before",
   *  `+7` means "due a week after". For sources like `sybill_callrecap`
   *  the anchor is creation-day. `null` (default) means the engine
   *  keeps its shipped-default logic — the config only overrides when
   *  an admin has typed a number. Kept as a small integer bounded by
   *  the editor UI to keep KV size trivial. */
  due_offset_days?: number | null;
  /** Same shape as `due_offset_days` but for the todo's `surface_at`
   *  timestamp (i.e. when the todo becomes visible in the CSM's
   *  active list — creating a todo with `surface_at` in the future
   *  scheduled it to appear later). Negative offsets bring the todo
   *  forward; positive offsets push it back. `null` = engine default. */
  surface_offset_days?: number | null;
  /** Per-variant timing overrides. Keys match the same variant scheme
   *  as `action_by_variant`. Only the fields the admin set on the
   *  variant are stored; missing fields fall through to the source-
   *  level `due_offset_days` / `surface_offset_days`, which in turn
   *  fall through to the engine default. Empty map / undefined = no
   *  per-variant overrides. */
  timing_by_variant?: Record<
    string,
    { due_offset_days?: number | null; surface_offset_days?: number | null }
  >;

  // ─── Legacy fields — email-only shape from before Slack actions ────
  //
  // Preserved on the type so on-disk KV rows written by the previous
  // editor still deserialize. `mergeTodoSourceConfigs` converts them
  // into `default_action` / `action_by_variant` at read time; downstream
  // code SHOULD NOT read these directly. Kept optional + undocumented
  // in the editor so nobody accidentally re-introduces a write path.

  /** @deprecated use `default_action` (kind: "email"). */
  linked_template_id?: string | null;
  /** @deprecated use `action_by_variant` (kind: "email"). */
  linked_template_by_variant?: Record<string, string | null>;
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
    /** When true, the settings UI advertises `{{renewal_date}}` +
     *  `{{days_until_renewal}}`. Only renewal-anchored sources set
     *  this; other sources don't have a renewal date in scope. */
    supports_renewal?: boolean;
    /** Variants supported for per-variant action bindings. When set,
     *  the settings editor renders a per-variant template picker
     *  alongside the single fallback dropdown. For renewal_milestone
     *  the variants are the four milestone-day values the engine
     *  fires at. Every variant is optional — leaving one unset means
     *  the source's fallback `linked_template_id` applies (or no
     *  button when that's null too).
     *
     *  Optional `group` field lets the editor render section headers
     *  when a source has many variants that naturally cluster (e.g.
     *  `slack_assign` has 16 onboarding steps + 4 live steps —
     *  rendering them under one flat list would be a scroll wall).
     *  When `group` is unset, variants render inline. When two or
     *  more variants share a group name, the editor emits one header
     *  before the first variant in that group. */
    variant_actions?: Array<{
      key: string;
      label: string;
      group?: string;
    }>;
  }
> = {
  renewal_milestone: {
    label: "Renewal milestone (90/60/30/7d)",
    description:
      "Fired by the renewal-milestones sweep when a customer's contract renewal date hits one of the tracked milestones. `{{milestone_days}}` interpolates to the specific day-count. Each milestone can bind a different outreach template — 90d for kickoff, 30d for pricing follow-up, etc.",
    supports_milestone: true,
    supports_prior_stage: false,
    supports_original_text: false,
    supports_renewal: true,
    variant_actions: [
      { key: "90", label: "90 days out" },
      { key: "60", label: "60 days out" },
      { key: "30", label: "30 days out" },
      { key: "7", label: "7 days out" },
    ],
  },
  renewal_confirmed: {
    label: "Renewal confirmed — verify invoice",
    description:
      "Fired when a customer transitions to the Renewal Confirmed lifecycle stage. `{{prior_stage}}` interpolates to the lifecycle stage they came from.",
    supports_milestone: false,
    supports_prior_stage: true,
    supports_original_text: false,
    supports_renewal: true,
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
    label: "Slack `@bot assign` playbook step",
    description:
      "Scheduled from the @bot assign playbook — either the onboarding sequence (17 timed steps from handoff → 90-day flip) or the shorter live/warm-book sequence (4 steps). Each step can bind its own outreach template so the action button on an onboarding kickoff todo opens a different draft than a 90-day check-in todo.",
    supports_milestone: false,
    supports_prior_stage: false,
    supports_original_text: true,
    // Keys match the `step_key` slug on each TodoTemplate entry in
    // src/lib/integrations/slack-assign.ts. Never renumber existing
    // keys — a rename here strands any admin binding at
    // /settings/todo-automation. Groups drive the section headers
    // in the editor UI.
    variant_actions: [
      {
        key: "onboarding:confirm_handoff",
        label: "Confirm handoff message",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:no_pkg_sales_timeline",
        label: "(No-pkg) Sales timeline check",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:with_pkg_internal_sync",
        label: "(With-pkg) Internal sync w/ AE + SE",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:watch_intro_email",
        label: "Watch for CSM intro email",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:internal_setup_hubspot",
        label: "Internal setup + HubSpot fields",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:schedule_kickoff",
        label: "Schedule kickoff call",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:prep_kickoff",
        label: "Prep kickoff (breakdown + deck)",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:run_kickoff",
        label: "Run kickoff call",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:post_kickoff",
        label: "Post-kickoff follow-up",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:migration_plan",
        label: "Build migration plan + CWUP",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:run_training",
        label: "Run training session",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:post_training",
        label: "Post-training follow-up",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:no_pkg_14_day",
        label: "(No-pkg) 14-day check-in",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:no_pkg_30_day",
        label: "(No-pkg) 30-day check-in",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:no_pkg_60_day",
        label: "(No-pkg) 60-day check-in + pre-audit",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:run_90_day",
        label: "Run 90-day check-in",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "onboarding:post_90_day",
        label: "Post-90-day: CSAT + flip to Live",
        group: "Onboarding playbook (17 steps)",
      },
      {
        key: "live:get_up_to_speed",
        label: "Get up to speed on the account",
        group: "Live playbook (4 steps)",
      },
      {
        key: "live:intro_call",
        label: "Schedule intro call",
        group: "Live playbook (4 steps)",
      },
      {
        key: "live:confirm_drive",
        label: "Confirm Drive folder + tracking",
        group: "Live playbook (4 steps)",
      },
      {
        key: "live:first_30_day",
        label: "First 30-day check-in",
        group: "Live playbook (4 steps)",
      },
    ],
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
    default_action: { kind: "none" },
  },
  renewal_confirmed: {
    // Original engine string: `Verify ${company} renewal went through`
    phrasing_template: "Verify {{company_name}} renewal went through",
    default_action: { kind: "none" },
  },
  sybill_callrecap: {
    // Sybill titles come straight from the parsed action item; template
    // just echoes the original text.
    phrasing_template: "{{original_text}}",
    default_action: { kind: "none" },
  },
  slack_assign: {
    // The 16-step playbook titles are step-specific; we echo the
    // original title the engine assembled. Kept in the registry so
    // an admin can prepend "@bot: " or similar without a deploy.
    phrasing_template: "{{original_text}}",
    default_action: { kind: "none" },
  },
  slack_slash: {
    phrasing_template: "{{original_text}}",
    default_action: { kind: "none" },
  },
  slack_dm: {
    phrasing_template: "{{original_text}}",
    default_action: { kind: "none" },
  },
  slack_reaction: {
    phrasing_template: "{{original_text}}",
    default_action: { kind: "none" },
  },
  scheduled: {
    phrasing_template: "{{original_text}}",
    default_action: { kind: "none" },
  },
  feature_request: {
    phrasing_template: "{{original_text}}",
    default_action: { kind: "none" },
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
    const merged: TodoSourceConfig = { ...base, ...(override ?? {}) };

    // Migrate legacy email-only fields into the tagged-union shape.
    // Rows written by the pre-Slack editor carry `linked_template_id`
    // (+ optional `linked_template_by_variant`); the new editor writes
    // `default_action` / `action_by_variant` directly. When both are
    // present we prefer the new fields (admins have re-saved on the
    // new editor). Legacy fields are dropped from the returned object
    // so downstream consumers see a single canonical shape.
    if (merged.default_action == null) {
      const legacyId = merged.linked_template_id?.trim();
      merged.default_action = legacyId
        ? { kind: "email", template_id: legacyId }
        : { kind: "none" };
    }
    if (
      merged.action_by_variant == null &&
      merged.linked_template_by_variant
    ) {
      const variantOut: Record<string, TodoAction> = {};
      for (const [k, tplId] of Object.entries(
        merged.linked_template_by_variant
      )) {
        const trimmed = tplId?.trim();
        if (trimmed) variantOut[k] = { kind: "email", template_id: trimmed };
      }
      if (Object.keys(variantOut).length > 0) merged.action_by_variant = variantOut;
    }
    delete merged.linked_template_id;
    delete merged.linked_template_by_variant;
    out[source] = merged;
  }
  return out;
}

/** Resolve the effective action for a todo based on its source's
 *  config + optional variant key. Variant wins over default; missing
 *  variant entry falls back to default; default `none` renders no
 *  button. Kept here (client-safe) so both the runtime button and the
 *  settings preview can share the same resolution logic. */
export function resolveTodoAction(
  cfg: TodoSourceConfig,
  variantKey: string | null | undefined
): TodoAction {
  if (variantKey) {
    const v = cfg.action_by_variant?.[variantKey];
    if (v) return v;
  }
  return cfg.default_action;
}

/** Resolve the effective due / surface offsets for a todo, falling
 *  through variant → source-level → null. Engines call this at
 *  todo-creation time to decide whether to shift their default
 *  timestamps. `null` on both fields means "engine keeps its shipped
 *  logic," which is the safe posture for sources that don't have an
 *  admin override written. */
export function resolveTodoTiming(
  cfg: TodoSourceConfig,
  variantKey: string | null | undefined
): { due_offset_days: number | null; surface_offset_days: number | null } {
  const variant = variantKey ? cfg.timing_by_variant?.[variantKey] : undefined;
  return {
    due_offset_days:
      (variant?.due_offset_days ?? cfg.due_offset_days) ?? null,
    surface_offset_days:
      (variant?.surface_offset_days ?? cfg.surface_offset_days) ?? null,
  };
}

/** Bounds enforced by the editor + `merge` on save. Wide enough for
 *  a full renewal cycle in either direction, tight enough that a
 *  typo can't schedule a todo years out. */
export const TODO_OFFSET_DAYS_MIN = -365;
export const TODO_OFFSET_DAYS_MAX = 365;

// ─── Merge tag registry (surfaced in the settings UI) ────────────────────

export interface MergeTagDescriptor {
  /** Handlebars-style token — what the admin writes in the template. */
  token: string;
  /** One-line hint that renders next to the tag in the editor. Kept
   *  short — the editor renders these inline. */
  hint: string;
}

/** Tags every source resolves at engine time — the customer is
 *  always in scope, so these are safe to advertise everywhere. */
export const UNIVERSAL_MERGE_TAGS: readonly MergeTagDescriptor[] = [
  { token: "company_name", hint: "customer.company_name (falls back to workspace_name)" },
  { token: "workspace_name", hint: "customer.workspace_name" },
  { token: "csm_name", hint: "assigned CSM (from HubSpot)" },
  { token: "owner_email", hint: "customer's primary contact email" },
  { token: "lifecycle_stage", hint: "current lifecycle stage" },
];

/** Return the full effective merge-tag list for a source: universal
 *  tags plus any source-specific ones opted into via SOURCE_METADATA
 *  (`supports_*` flags). Used by the settings editor to render the
 *  helper text under each phrasing template AND by engines that want
 *  to sanity-check which tags a template can reference. */
export function mergeTagsForSource(
  meta: (typeof SOURCE_METADATA)[AutomatedSource]
): MergeTagDescriptor[] {
  const out: MergeTagDescriptor[] = [...UNIVERSAL_MERGE_TAGS];
  if (meta.supports_milestone) {
    out.push({
      token: "milestone_days",
      hint: "90 / 60 / 30 / 7 for renewal_milestone",
    });
  }
  if (meta.supports_prior_stage) {
    out.push({
      token: "prior_stage",
      hint: "lifecycle stage the customer came from",
    });
  }
  if (meta.supports_renewal) {
    out.push({
      token: "renewal_date",
      hint: "customer.contract_renewal (YYYY-MM-DD)",
    });
    out.push({
      token: "days_until_renewal",
      hint: "integer days from today to renewal",
    });
  }
  if (meta.supports_original_text) {
    out.push({
      token: "original_text",
      hint: "the caller's raw text (Slack body, Sybill bullet, etc.)",
    });
  }
  return out;
}
