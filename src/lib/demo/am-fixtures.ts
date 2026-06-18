/**
 * AM-tab fixtures for DEMO_MODE. Hand-built rows for the Past Due
 * and Approaching Enterprise panels so the AM side of the dashboard
 * looks populated without touching the real q24620 / q13268
 * Metabase queries.
 *
 * The Renewals tab and the Proactive Outreach tab read from the same
 * customer book that loadCustomers() serves up, so they need no
 * additional fixture beyond what's in customer-fixture.ts. Only the
 * two cohort loaders below have their own snapshot path that we
 * have to stub.
 */

import type {
  ApproachingEntRow,
  PastDueRow,
} from "@/lib/engines/am-cohorts";

const today = new Date();

function isoDaysAgo(days: number): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/** Approaching Enterprise — publications close to or over their plan
 *  cap. Mix of "approaching" (~85-95%) and "over cap" (>100%) so the
 *  panel's tier groupings have rows in each bucket. */
export function buildDemoApproachingEnt(): ApproachingEntRow[] {
  return [
    {
      organization_id: "ws-demo-007-coastline-currents",
      workspace_name: "Coastline Currents",
      owner_email: "harper@coastlinecurrents.example.com",
      owner_name: "Harper Quinn",
      stripe_customer_id: "cus_demo_007",
      masquerade_url: null,
      plan_name: "Scale",
      billing_interval: "year",
      max_subscriptions: 50_000,
      total_subscriptions: 36_100,
      percent_to: 0.722,
      remaining: 13_900,
      last_send: isoDaysAgo(4),
      last_payment_amount: 1500,
      last_payment_at: isoDaysAgo(40),
      websites: "coastlinecurrents.example.com",
      have_started_t4_recommendations: false,
      completed_t4_recommendations: false,
      grew_via_boost: true,
      monetization_via_boost: false,
      direct_sponsorships_enabled: false,
      ad_placement: false,
      raw: {},
    },
    {
      organization_id: "ws-demo-008-quarry-quarterly",
      workspace_name: "Quarry Quarterly",
      owner_email: "iris@quarryq.example.com",
      owner_name: "Iris Wallace",
      stripe_customer_id: "cus_demo_008",
      masquerade_url: null,
      plan_name: "Scale",
      billing_interval: "year",
      max_subscriptions: 25_000,
      total_subscriptions: 19_800,
      percent_to: 0.792,
      remaining: 5_200,
      last_send: isoDaysAgo(5),
      last_payment_amount: 1200,
      last_payment_at: isoDaysAgo(60),
      websites: "quarryquarterly.example.com",
      have_started_t4_recommendations: false,
      completed_t4_recommendations: false,
      grew_via_boost: true,
      monetization_via_boost: false,
      direct_sponsorships_enabled: false,
      ad_placement: true,
      raw: {},
    },
    {
      organization_id: "ws-demo-009-bayside-bulletin",
      workspace_name: "Bayside Bulletin",
      owner_email: "noah@baysidebulletin.example.com",
      owner_name: "Noah Park",
      stripe_customer_id: "cus_demo_009",
      masquerade_url: null,
      plan_name: "Scale",
      billing_interval: "month",
      max_subscriptions: 15_000,
      total_subscriptions: 13_900,
      percent_to: 0.927,
      remaining: 1_100,
      last_send: isoDaysAgo(8),
      last_payment_amount: 99,
      last_payment_at: isoDaysAgo(10),
      websites: "baysidebulletin.example.com",
      have_started_t4_recommendations: true,
      completed_t4_recommendations: false,
      grew_via_boost: false,
      monetization_via_boost: false,
      direct_sponsorships_enabled: false,
      ad_placement: false,
      raw: {},
    },
    {
      organization_id: "ws-demo-013-lantern-letter",
      workspace_name: "Lantern Letter",
      owner_email: "toni@lanternletter.example.com",
      owner_name: "Toni Marsh",
      stripe_customer_id: "cus_demo_013",
      masquerade_url: null,
      plan_name: "Grow",
      billing_interval: "month",
      max_subscriptions: 10_000,
      total_subscriptions: 9_650,
      percent_to: 0.965,
      remaining: 350,
      last_send: isoDaysAgo(4),
      last_payment_amount: 49,
      last_payment_at: isoDaysAgo(12),
      websites: "lanternletter.example.com",
      have_started_t4_recommendations: false,
      completed_t4_recommendations: false,
      grew_via_boost: false,
      monetization_via_boost: false,
      direct_sponsorships_enabled: false,
      ad_placement: false,
      raw: {},
    },
    {
      organization_id: "ws-demo-014-foundry-field-notes",
      workspace_name: "Foundry Field Notes",
      owner_email: "eli@foundryfn.example.com",
      owner_name: "Eli Yates",
      stripe_customer_id: "cus_demo_014",
      masquerade_url: null,
      plan_name: "Grow",
      billing_interval: "month",
      max_subscriptions: 5_000,
      total_subscriptions: 5_180,
      percent_to: 1.036,
      remaining: -180,
      last_send: isoDaysAgo(7),
      last_payment_amount: 49,
      last_payment_at: isoDaysAgo(15),
      websites: "foundryfn.example.com",
      have_started_t4_recommendations: false,
      completed_t4_recommendations: false,
      grew_via_boost: false,
      monetization_via_boost: false,
      direct_sponsorships_enabled: false,
      ad_placement: false,
      raw: {},
    },
  ];
}

/** Past Due — failed charges + Stripe customer info. Each row carries
 *  a realistic-looking failure_message so the panel's status pill +
 *  Stripe link both look right. */
export function buildDemoPastDue(): PastDueRow[] {
  return [
    {
      customer_success_manager: "Demo_User",
      customer_id: "cus_demo_015",
      email: "wren@cobblestonec.example.com",
      subscription_id: "sub_demo_015_a",
      subscription_status: "past_due",
      price_name: "Enterprise @ 50,000 - $30,000.00/y",
      arr_dollars: 30_000,
      charge_amount_dollars: 30_000,
      charge_status: "failed",
      charge_attempted_at: isoDaysAgo(8),
      failure_code: "card_declined",
      failure_message: "Your card was declined.",
      auto_upgrade: null,
      raw: {},
    },
    {
      customer_success_manager: "Demo_User",
      customer_id: "cus_demo_009",
      email: "noah@baysidebulletin.example.com",
      subscription_id: "sub_demo_009_a",
      subscription_status: "past_due",
      price_name: "Scale @ 15,000 - $99.00/mo",
      arr_dollars: 1_188,
      charge_amount_dollars: 99,
      charge_status: "failed",
      charge_attempted_at: isoDaysAgo(3),
      failure_code: "insufficient_funds",
      failure_message: "Your card has insufficient funds.",
      auto_upgrade: null,
      raw: {},
    },
    {
      customer_success_manager: "Demo_User",
      customer_id: "cus_demo_005",
      email: "mira@tideline.example.com",
      subscription_id: "sub_demo_005_a",
      subscription_status: "past_due",
      price_name: "Enterprise @ 50,000 - $5,000.00/mo",
      arr_dollars: 60_000,
      charge_amount_dollars: 5_000,
      charge_status: "failed",
      charge_attempted_at: isoDaysAgo(14),
      failure_code: "expired_card",
      failure_message: "Your card has expired.",
      auto_upgrade: null,
      raw: {},
    },
  ];
}
