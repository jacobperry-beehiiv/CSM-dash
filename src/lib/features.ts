import type { Customer } from "./types";

export type FeatureState = "active" | "inactive" | "started" | "completed" | "unknown";

export interface FeatureStatus {
  key: string;
  label: string;
  group: "Monetization" | "Growth" | "Onboarding" | "Activity";
  state: FeatureState;
  detail?: string;
}

function hasRecentSend(c: Customer): FeatureState {
  if (!c.last_send) return "inactive";
  const days = Math.ceil(
    (Date.now() - new Date(c.last_send).getTime()) / (1000 * 60 * 60 * 24)
  );
  return days <= 14 ? "active" : "inactive";
}

function hasRecentLogin(c: Customer): FeatureState {
  return c.last_log_in != null ? "active" : "inactive";
}

function boolToState(b: boolean | null | undefined): FeatureState {
  if (b === true) return "active";
  if (b === false) return "inactive";
  return "unknown";
}

function t4State(c: Customer): FeatureState {
  if (c.completed_t4_recommendations === true) return "completed";
  if (c.have_started_t4_recommendations === true) return "started";
  return "inactive";
}

export function customerFeatures(c: Customer): FeatureStatus[] {
  return [
    {
      key: "ad_placement",
      label: "Ad placements live",
      group: "Monetization",
      state: boolToState(c.ad_placement),
      detail: "Running ads in newsletter sends.",
    },
    {
      key: "direct_sponsorships_enabled",
      label: "Direct sponsorships",
      group: "Monetization",
      state: boolToState(c.direct_sponsorships_enabled),
      detail: "Selling direct ad inventory via beehiiv.",
    },
    {
      key: "monetization_via_boost",
      label: "Monetizing via Boosts",
      group: "Monetization",
      state: boolToState(c.monetization_via_boost),
      detail: "Earning revenue by recommending other newsletters.",
    },
    {
      key: "grew_via_boost",
      label: "Growing via Boosts",
      group: "Growth",
      state: boolToState(c.grew_via_boost),
      detail: "Acquiring subscribers from other Boost-enabled publications.",
    },
    {
      key: "t4_recommendations",
      label: "T4 onboarding recommendations",
      group: "Onboarding",
      state: t4State(c),
      detail:
        "Tier-4 onboarding checklist — not used / started / completed depending on HubSpot status.",
    },
    {
      key: "recent_send",
      label: "Sent in last 14 days",
      group: "Activity",
      state: hasRecentSend(c),
      detail: c.last_send
        ? `Last send: ${new Date(c.last_send).toLocaleDateString()}`
        : "No send recorded.",
    },
    {
      key: "recent_login",
      label: "Logged in last 14 days",
      group: "Activity",
      state: hasRecentLogin(c),
      detail:
        "q10600 only populates last_log_in when the most-recent login is within 14 days.",
    },
  ];
}

export function featureCounts(c: Customer): { active: number; total: number } {
  const list = customerFeatures(c);
  return {
    active: list.filter(
      (f) => f.state === "active" || f.state === "completed"
    ).length,
    total: list.length,
  };
}
