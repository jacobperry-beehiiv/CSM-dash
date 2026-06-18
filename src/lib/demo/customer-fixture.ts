/**
 * Hand-built customer book for DEMO_MODE. Fifteen fictional
 * publications spanning Enterprise / Scale / Grow plans so screenshots
 * of /csm book + /csm at-risk look populated and varied.
 *
 * Design notes:
 *   - Every workspace_id is a deterministic UUID-shaped string so deep
 *     links into the dashboard work and the React keys are stable.
 *   - CSM is uniformly "Demo_User" / demo@beehiiv.com so the page's
 *     viewer-email filter resolves to a known handle. (Pages that
 *     scope to the viewer's book are also overridden in demo mode to
 *     show the full fixture — see load-customers patches.)
 *   - The at-risk engine runs unchanged against this fixture, so a few
 *     rows are deliberately seeded with stale last_log_in / last_send /
 *     low-percent_of_max_subs to make sure the at-risk tab has
 *     something to show.
 *   - Names + emails are fictional. Any resemblance to real publishers
 *     is unintentional.
 */

import type { Customer } from "@/lib/types";

const VIEWER_CSM_HANDLE = "Demo_User";
const VIEWER_EMAIL = "demo@beehiiv.com";

/** Helpers to build ISO dates relative to today without using
 *  Date.now() in module scope (which breaks SSR snapshots). All call
 *  sites pass a deterministic offset; the "today" baseline is
 *  computed lazily inside loadCustomers when the fixture is read. */
export function daysAgo(days: number, today: Date): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export function monthsFromNow(months: number, today: Date): string {
  const d = new Date(today);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export interface FixtureSeed {
  workspace_id: string;
  workspace_name: string;
  arr: number;
  active_subs: number;
  max_subscriptions: number;
  stripe_plan: string;
  interval: "month" | "year";
  property_company_status: string;
  property_main_contact: string;
  owner_email: string;
  last_send_days_ago: number;
  last_log_in_days_ago: number;
  last_activity_days_ago: number;
  renewal_in_months: number;
  property_risk_level?: string;
  /** Free-text note for the detail panel. */
  property_risk_level_detail?: string;
  /** Whether ads / boosts / sponsorships are toggled on. Drives the
   *  feature flag chips on the book table. */
  features?: {
    direct_sponsorships?: boolean;
    ad_placement?: boolean;
    grew_via_boost?: boolean;
    monetization_via_boost?: boolean;
  };
}

const SEEDS: FixtureSeed[] = [
  // ── Healthy Enterprise ──────────────────────────────────────────
  {
    workspace_id: "ws-demo-001-morning-brew-makers",
    workspace_name: "Morning Brew Makers",
    arr: 240_000,
    active_subs: 412_000,
    max_subscriptions: 500_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Ali Carter",
    owner_email: "ali@brewmakers.example.com",
    last_send_days_ago: 1,
    last_log_in_days_ago: 0,
    last_activity_days_ago: 3,
    renewal_in_months: 8,
    property_risk_level: "Light Green",
    features: {
      direct_sponsorships: true,
      ad_placement: true,
      grew_via_boost: true,
      monetization_via_boost: true,
    },
  },
  {
    workspace_id: "ws-demo-002-northbridge-weekly",
    workspace_name: "Northbridge Weekly",
    arr: 180_000,
    active_subs: 226_500,
    max_subscriptions: 300_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Sam Reyes",
    owner_email: "sam@northbridgeweekly.example.com",
    last_send_days_ago: 2,
    last_log_in_days_ago: 1,
    last_activity_days_ago: 5,
    renewal_in_months: 4,
    property_risk_level: "Light Green",
    features: {
      ad_placement: true,
      grew_via_boost: true,
    },
  },
  {
    workspace_id: "ws-demo-003-channel-echo",
    workspace_name: "Channel Echo",
    arr: 96_000,
    active_subs: 78_400,
    max_subscriptions: 100_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Priya Mehta",
    owner_email: "priya@channelecho.example.com",
    last_send_days_ago: 3,
    last_log_in_days_ago: 0,
    last_activity_days_ago: 2,
    renewal_in_months: 6,
    property_risk_level: "Light Green",
    features: {
      direct_sponsorships: true,
      monetization_via_boost: true,
    },
  },

  // ── At-risk Enterprise (stale activity, missing logins) ────────
  {
    workspace_id: "ws-demo-004-roundtable-quarterly",
    workspace_name: "Roundtable Quarterly",
    arr: 72_000,
    active_subs: 21_300,
    max_subscriptions: 75_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Jordan Ng",
    owner_email: "jordan@roundtableq.example.com",
    last_send_days_ago: 67,
    last_log_in_days_ago: 54,
    last_activity_days_ago: 41,
    renewal_in_months: 2,
    property_risk_level: "Yellow",
    property_risk_level_detail:
      "No send in 60+ days; renewal coming up. Schedule check-in.",
  },
  {
    workspace_id: "ws-demo-005-tideline-bulletin",
    workspace_name: "Tideline Bulletin",
    arr: 60_000,
    active_subs: 12_900,
    max_subscriptions: 50_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Mira Okafor",
    owner_email: "mira@tideline.example.com",
    last_send_days_ago: 89,
    last_log_in_days_ago: 102,
    last_activity_days_ago: 70,
    renewal_in_months: 1,
    property_risk_level: "Red",
    property_risk_level_detail:
      "Renewal in 30 days. No sends since Q1, no logins in 3+ months.",
  },
  {
    workspace_id: "ws-demo-006-pinegrove-press",
    workspace_name: "Pinegrove Press",
    arr: 108_000,
    active_subs: 88_500,
    max_subscriptions: 120_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Devon Hayes",
    owner_email: "devon@pinegrovepress.example.com",
    last_send_days_ago: 6,
    last_log_in_days_ago: 32,
    last_activity_days_ago: 24,
    renewal_in_months: 3,
    property_risk_level: "Yellow",
    property_risk_level_detail:
      "Engagement dipping — last login 30+ days ago. Renewal in Q1.",
    features: {
      ad_placement: true,
    },
  },

  // ── Scale tier ──────────────────────────────────────────────────
  {
    workspace_id: "ws-demo-007-coastline-currents",
    workspace_name: "Coastline Currents",
    arr: 18_000,
    active_subs: 36_100,
    max_subscriptions: 50_000,
    stripe_plan: "Scale",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Harper Quinn",
    owner_email: "harper@coastlinecurrents.example.com",
    last_send_days_ago: 4,
    last_log_in_days_ago: 2,
    last_activity_days_ago: 9,
    renewal_in_months: 5,
    features: {
      grew_via_boost: true,
    },
  },
  {
    workspace_id: "ws-demo-008-quarry-quarterly",
    workspace_name: "Quarry Quarterly",
    arr: 14_400,
    active_subs: 19_800,
    max_subscriptions: 25_000,
    stripe_plan: "Scale",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Iris Wallace",
    owner_email: "iris@quarryq.example.com",
    last_send_days_ago: 5,
    last_log_in_days_ago: 3,
    last_activity_days_ago: 12,
    renewal_in_months: 9,
    features: {
      ad_placement: true,
      grew_via_boost: true,
    },
  },
  {
    workspace_id: "ws-demo-009-bayside-bulletin",
    workspace_name: "Bayside Bulletin",
    arr: 9_600,
    active_subs: 11_400,
    max_subscriptions: 15_000,
    stripe_plan: "Scale",
    interval: "month",
    property_company_status: "Live",
    property_main_contact: "Noah Park",
    owner_email: "noah@baysidebulletin.example.com",
    last_send_days_ago: 8,
    last_log_in_days_ago: 6,
    last_activity_days_ago: 14,
    renewal_in_months: 11,
  },

  // ── Growth opportunity (low utilization) ───────────────────────
  {
    workspace_id: "ws-demo-010-glasswater-gazette",
    workspace_name: "Glasswater Gazette",
    arr: 48_000,
    active_subs: 14_200,
    max_subscriptions: 75_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Riley Nakamura",
    owner_email: "riley@glasswater.example.com",
    last_send_days_ago: 3,
    last_log_in_days_ago: 1,
    last_activity_days_ago: 4,
    renewal_in_months: 7,
    property_risk_level: "Yellow",
    property_risk_level_detail:
      "Plan headroom underutilized — explore growth campaigns.",
  },
  {
    workspace_id: "ws-demo-011-harbor-herald",
    workspace_name: "Harbor Herald",
    arr: 36_000,
    active_subs: 9_300,
    max_subscriptions: 50_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Live",
    property_main_contact: "Casey Bloom",
    owner_email: "casey@harborherald.example.com",
    last_send_days_ago: 2,
    last_log_in_days_ago: 0,
    last_activity_days_ago: 6,
    renewal_in_months: 10,
  },

  // ── Onboarding (just live, low engagement still ramping) ───────
  {
    workspace_id: "ws-demo-012-skyline-sundays",
    workspace_name: "Skyline Sundays",
    arr: 24_000,
    active_subs: 3_100,
    max_subscriptions: 25_000,
    stripe_plan: "Scale",
    interval: "year",
    property_company_status: "Onboarding",
    property_main_contact: "Avery Lindon",
    owner_email: "avery@skylinesundays.example.com",
    last_send_days_ago: 12,
    last_log_in_days_ago: 5,
    last_activity_days_ago: 7,
    renewal_in_months: 11,
  },

  // ── Grow tier (entry-level paid) ───────────────────────────────
  {
    workspace_id: "ws-demo-013-lantern-letter",
    workspace_name: "Lantern Letter",
    arr: 2_400,
    active_subs: 7_800,
    max_subscriptions: 10_000,
    stripe_plan: "Grow",
    interval: "month",
    property_company_status: "Live",
    property_main_contact: "Toni Marsh",
    owner_email: "toni@lanternletter.example.com",
    last_send_days_ago: 4,
    last_log_in_days_ago: 2,
    last_activity_days_ago: 11,
    renewal_in_months: 0,
  },
  {
    workspace_id: "ws-demo-014-foundry-field-notes",
    workspace_name: "Foundry Field Notes",
    arr: 1_800,
    active_subs: 4_400,
    max_subscriptions: 5_000,
    stripe_plan: "Grow",
    interval: "month",
    property_company_status: "Live",
    property_main_contact: "Eli Yates",
    owner_email: "eli@foundryfn.example.com",
    last_send_days_ago: 7,
    last_log_in_days_ago: 3,
    last_activity_days_ago: 14,
    renewal_in_months: 0,
  },

  // ── Past-due reference (also seeds the AM Past Due tab) ─────────
  {
    workspace_id: "ws-demo-015-cobblestone-courier",
    workspace_name: "Cobblestone Courier",
    arr: 30_000,
    active_subs: 22_700,
    max_subscriptions: 50_000,
    stripe_plan: "Enterprise",
    interval: "year",
    property_company_status: "Past Due",
    property_main_contact: "Wren Lopez",
    owner_email: "wren@cobblestonec.example.com",
    last_send_days_ago: 3,
    last_log_in_days_ago: 4,
    last_activity_days_ago: 8,
    renewal_in_months: -1,
    property_risk_level: "Red",
    property_risk_level_detail:
      "Invoice failed for the past 2 months. Stripe outreach in progress.",
  },
];

/** Compute the full demo book at request time. Lazy on `today` so we
 *  don't bake build-time dates into the bundle. */
export function buildDemoCustomers(today: Date = new Date()): Customer[] {
  return SEEDS.map((seed) => {
    const c: Customer = {
      workspace_id: seed.workspace_id,
      workspace_name: seed.workspace_name,
      company_name: seed.workspace_name,
      owner_email: seed.owner_email,
      mrr: Math.round(seed.arr / 12),
      arr: seed.arr,
      active_subs: seed.active_subs,
      max_subscriptions: seed.max_subscriptions,
      renewal_date: monthsFromNow(seed.renewal_in_months, today),
      company_engagement: null,
      customer_success_manager: VIEWER_CSM_HANDLE,
      customer_success_manager_email: VIEWER_EMAIL,
      property_company_status: seed.property_company_status,
      property_main_contact: seed.property_main_contact,
      stripe_plan: seed.stripe_plan,
      interval: seed.interval,
      last_send: daysAgo(seed.last_send_days_ago, today),
      last_log_in: daysAgo(seed.last_log_in_days_ago, today),
      mon_since_1st_ent: 14,
      percent_of_max_subs:
        seed.max_subscriptions > 0
          ? (seed.active_subs / seed.max_subscriptions) * 100
          : null,
      direct_sponsorships_enabled: seed.features?.direct_sponsorships ?? false,
      ad_placement: seed.features?.ad_placement ?? false,
      grew_via_boost: seed.features?.grew_via_boost ?? false,
      monetization_via_boost: seed.features?.monetization_via_boost ?? false,
      property_risk_level: seed.property_risk_level ?? null,
      property_risk_level_detail: seed.property_risk_level_detail ?? null,
      last_activity_at: daysAgo(seed.last_activity_days_ago, today),
      last_activity_source: "demo",
      hubspot_company_id: null,
      hubspot_contacts: null,
      hubspot_link_source: "none",
    };
    return c;
  });
}
