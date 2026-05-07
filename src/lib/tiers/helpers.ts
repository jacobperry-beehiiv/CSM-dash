import type { Customer } from "../types";
import type { EnterpriseTier } from "./store";

/**
 * Returns the customer's current tier — the smallest tier whose `max_subs`
 * fits the customer's `max_subscriptions` (preferred) or `active_subs`.
 * Returns null if no tier covers them (above the top of the ladder).
 */
export function findCurrentTier(
  customer: Customer,
  ladder: EnterpriseTier[]
): EnterpriseTier | null {
  if (ladder.length === 0) return null;
  // Prefer the contracted cap, fall back to active subs.
  const target = customer.max_subscriptions ?? customer.active_subs ?? 0;
  if (!target) return null;
  // Ladder is sorted ascending by max_subs in the store.
  for (const t of ladder) {
    if (target <= t.max_subs) return t;
  }
  // Customer is above the highest tier — return the top tier with a flag
  // so callers can render "above 10M" copy if needed.
  return ladder[ladder.length - 1];
}

/**
 * Returns up to `n` tiers ABOVE the customer's current tier. Used for
 * upgrade-conversation merge tags.
 */
export function nextTiers(
  customer: Customer,
  ladder: EnterpriseTier[],
  n: number
): EnterpriseTier[] {
  if (ladder.length === 0) return [];
  const current = findCurrentTier(customer, ladder);
  if (!current) {
    // No current tier (no sub data) — return the bottom n as a default.
    return ladder.slice(0, n);
  }
  const idx = ladder.findIndex((t) => t.name === current.name);
  return ladder.slice(idx + 1, idx + 1 + n);
}

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** Format a tier's price honoring the customer's billing cadence. */
export function fmtTierPrice(
  tier: EnterpriseTier,
  customer: Customer
): string {
  const interval = (customer.interval ?? "").toLowerCase();
  const isMonthly = interval === "month" || interval === "monthly";
  if (isMonthly && tier.monthly_usd) {
    return `${fmtUSD(tier.monthly_usd)}/mo`;
  }
  if (tier.annual_usd) {
    return `${fmtUSD(tier.annual_usd)}/yr`;
  }
  // Fallback when only one cadence has pricing
  if (tier.monthly_usd) return `${fmtUSD(tier.monthly_usd)}/mo`;
  return "—";
}

/** "500K subs / $50K/yr" */
export function fmtTier(tier: EnterpriseTier, customer: Customer): string {
  return `${tier.name} subs / ${fmtTierPrice(tier, customer)}`;
}

export function fmtTierLadderHtml(
  tiers: EnterpriseTier[],
  customer: Customer
): string {
  if (tiers.length === 0) return "";
  const items = tiers
    .map(
      (t) =>
        `<li><strong>${t.name} subs</strong> — ${fmtTierPrice(t, customer)}</li>`
    )
    .join("");
  return `<ul>${items}</ul>`;
}

export function fmtTierLadderText(
  tiers: EnterpriseTier[],
  customer: Customer
): string {
  if (tiers.length === 0) return "";
  return tiers.map((t) => `  • ${fmtTier(t, customer)}`).join("\n");
}
