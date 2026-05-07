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

export interface SlackSettings {
  /** Default channel ID for past-due notifications, e.g. C0AMK142WUR. */
  past_due_channel: string;
  /** Message template (supports merge tags). Plain text — Slack mrkdwn. */
  past_due_template: string;
  /** Map of customer_success_manager (e.g. "Jacob_Perry") → Slack user ID
   *  (e.g. "U02ABC123") so {{customer.csm_slack}} renders an actual @mention. */
  csm_user_ids: Record<string, string>;
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
    past_due_channel: "",
    past_due_template:
      "*Past-Due Enterprise alert*\n\nTotal Enterprise ARR past due: *{{total_arr}}* across *{{count}}* account{{count_plural}}.\n\n{{account_list}}\n\nLet me know if any of these are already in motion 🙏",
    csm_user_ids: {},
  },
};
