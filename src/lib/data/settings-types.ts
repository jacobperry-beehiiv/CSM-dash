import type { RiskFlagCode } from "../types";

/**
 * Pure type/constant module — safe to import from client components.
 * Don't add Node-only imports here. The store implementation lives in
 * settings.ts (server-only).
 */

export interface FlagPeriod {
  /** When a flag is marked resolved, how long before it can re-raise.
   *  Set to 0 for "never re-raise" (manual unresolve required). */
  re_raise_days: number;
}

/**
 * One configured Slack destination — channel + the default message
 * template used when alerts of this type get sent. Multiple instances
 * live in `slack.channels` so different alert types can target
 * different channels (e.g. past-due in #am-alerts, at-risk in
 * #csm-alerts).
 */
export interface SlackChannel {
  /** Stable id used by app code to look up the right channel for a
   *  given alert type (e.g. "past_due", "at_risk"). Generated from the
   *  label when added; never changes once created. */
  id: string;
  /** Display label shown in the settings UI ("Past-due alerts"). */
  label: string;
  /** Slack channel ID, e.g. "C0AMK142WUR". */
  channel_id: string;
  /** Default Slack-mrkdwn message template with `{{token}}` merge tags.
   *  The available tokens depend on which alert type uses this channel
   *  — past-due supports {{total_arr}} / {{count}} / {{count_plural}} /
   *  {{account_list}} / {{customer_ids}}. */
  template: string;
  /** Optional per-row template for the `{{account_list}}` expansion. Each
   *  selected row gets rendered with this template, then joined with
   *  newlines. Past-due row tokens: `{{email}}`, `{{customer_id}}`,
   *  `{{plan}}`, `{{arr}}`, `{{charge_amount}}`, `{{failure_code}}`,
   *  `{{attempted_at}}`, `{{csm}}` (resolves to a Slack @mention when
   *  mapped). When unset or empty, falls back to the hard-coded format
   *  the dashboard shipped with. */
  row_template?: string;
}

/** Stable id reserved for the past-due alert. The /am page looks this
 *  up explicitly to find the right channel config. */
export const PAST_DUE_CHANNEL_ID = "past_due";

/** Map of customer_success_manager (e.g. "Jacob_Perry") → Slack user ID
 *  (e.g. "U02ABC123") so {{customer.csm_slack}} renders an actual @mention. */
export type CsmSlackIdMap = Record<string, string>;

export interface SlackSettings {
  /** All configured channel destinations. Code looks up an entry by `id`
   *  (e.g. PAST_DUE_CHANNEL_ID) to find the channel + template for a
   *  given alert type. Extensible — admins can add new channel rows
   *  from /settings/slack without a code change. */
  channels: SlackChannel[];
  csm_user_ids: CsmSlackIdMap;

  // ─── Deprecated single-channel fields ──────────────────────────────
  // Kept on the type so old stored values still parse; the load path
  // auto-migrates them into a `past_due` entry in `channels` on first
  // hydrate. Don't read these directly in new code.
  /** @deprecated use channels.find(c => c.id === PAST_DUE_CHANNEL_ID) */
  past_due_channel?: string;
  /** @deprecated use channels.find(c => c.id === PAST_DUE_CHANNEL_ID) */
  past_due_template?: string;
}

export interface SettingsShape {
  flags: Record<RiskFlagCode, FlagPeriod>;
  thresholds: {
    days_no_send: number;
    pct_under_tier: number;
    days_no_contact_short: number;
    util_red_pct: number;
    util_amber_pct: number;
    /** Fallback per-1K-subs-per-ad rate used by the ad-gap engine when the
     *  customer has no internal payout history to extrapolate from.
     *  Beehiiv's network rates vary by niche/demand; $5/K is a reasonable
     *  conservative default. */
    ad_default_rate_per_k_subs_usd: number;
  };
  slack: SlackSettings;
}

export const DEFAULTS: SettingsShape = {
  flags: {
    A: { re_raise_days: 14 },
    B: { re_raise_days: 14 },
    C: { re_raise_days: 30 },
    D: { re_raise_days: 7 },
    E: { re_raise_days: 30 },
    F: { re_raise_days: 30 },
    G: { re_raise_days: 21 },
    H: { re_raise_days: 14 },
  },
  thresholds: {
    days_no_send: 10,
    pct_under_tier: 0.75,
    days_no_contact_short: 45,
    util_red_pct: 90,
    util_amber_pct: 75,
    ad_default_rate_per_k_subs_usd: 5,
  },
  slack: {
    channels: [
      {
        id: PAST_DUE_CHANNEL_ID,
        label: "Past-due alerts",
        channel_id: "",
        template:
          "*Past-Due Enterprise alert*\n\nTotal Enterprise ARR past due: *{{total_arr}}* across *{{count}}* account{{count_plural}}.\n\n{{account_list}}\n\nLet me know if any of these are already in motion 🙏",
        row_template:
          "• *{{email}}* — {{charge_amount}} failed charge, {{arr}} ARR (CSM: {{csm}})",
      },
    ],
    csm_user_ids: {},
  },
};

/**
 * Generate a stable `id` for a new Slack channel entry from its label.
 * Same flavor as `newMemberId` in team-tasks — lowercased, alphanumeric
 * + underscores, collision suffix if needed. The id never changes after
 * creation so code lookups stay stable across label renames.
 */
export function newChannelId(
  label: string,
  existingIds: Iterable<string>
): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "channel";
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Helper for callers (e.g. past-due-panel) that want to find the
 *  channel config for a given alert type. Returns null when nothing
 *  matches so the UI can render a "configure me" prompt. */
export function findSlackChannel(
  slack: SlackSettings,
  id: string
): SlackChannel | null {
  return slack.channels.find((c) => c.id === id) ?? null;
}
