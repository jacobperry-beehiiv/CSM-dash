import type { AdGapReport, Customer } from "../types";
import { lastContacted } from "../customer-helpers";
import type { EnterpriseTier } from "../tiers/store";
import {
  fmtTier,
  fmtTierLadderHtml,
  fmtTierLadderText,
  fmtTierPrice,
  findCurrentTier,
  nextTiers,
} from "../tiers/helpers";

/**
 * Merge-tag interpolator. Replaces `{{token}}` occurrences in a string with
 * a value computed from the customer record (and optional context).
 */

export interface MergeContext {
  /** Loaded by callers that want tier-related tags to resolve. When absent,
   *  tier tokens resolve to "—" so the placeholder is visible in the draft. */
  ladder?: EnterpriseTier[];
  /** Loaded by callers that want ad-revenue tags to resolve (single-customer
   *  flows only — bulk drafting skips this for performance). */
  adGap?: AdGapReport | null;
}

export interface MergeTag {
  token: string;
  label: string;
  description: string;
  resolve: (c: Customer, ctx: MergeContext) => string;
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null) return "$—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function firstName(s: string | null | undefined): string {
  if (!s) return "there";
  return s.trim().split(/\s+/)[0] || "there";
}

function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = n > 1 ? n : n * 100;
  return `${v.toFixed(0)}%`;
}

// ─── Tier-aware resolvers ─────────────────────────────────────────────
// All return "—" when no ladder context is provided so the missing data is
// visible in the rendered preview rather than silently empty.

function tierResolver(
  pick: (
    customer: Customer,
    ladder: EnterpriseTier[]
  ) => string | null
): (c: Customer, ctx: MergeContext) => string {
  return (c, ctx) => {
    if (!ctx.ladder) return "—";
    return pick(c, ctx.ladder) ?? "—";
  };
}

function nthNextTier(n: number) {
  return (c: Customer, ladder: EnterpriseTier[]): string | null => {
    const list = nextTiers(c, ladder, n + 1);
    const t = list[n];
    return t ? fmtTier(t, c) : null;
  };
}

function nthNextTierSubs(n: number) {
  return (c: Customer, ladder: EnterpriseTier[]): string | null => {
    const list = nextTiers(c, ladder, n + 1);
    return list[n]?.name ?? null;
  };
}

function nthNextTierPrice(n: number) {
  return (c: Customer, ladder: EnterpriseTier[]): string | null => {
    const list = nextTiers(c, ladder, n + 1);
    const t = list[n];
    return t ? fmtTierPrice(t, c) : null;
  };
}

export const MERGE_TAGS: MergeTag[] = [
  {
    token: "customer.name",
    label: "Company name",
    description: "Company display name (falls back to workspace name).",
    resolve: (c) => c.company_name ?? c.workspace_name ?? "your team",
  },
  {
    token: "customer.contact",
    label: "Main contact",
    description: "HubSpot 'main contact' for the account.",
    resolve: (c) => c.property_main_contact ?? c.owner_email ?? "there",
  },
  {
    token: "customer.contact_first_name",
    label: "Contact first name",
    description: "First name of the main contact.",
    resolve: (c) => firstName(c.property_main_contact),
  },
  {
    token: "customer.email",
    label: "Owner email",
    description: "Workspace owner email.",
    resolve: (c) => c.owner_email ?? "",
  },
  {
    token: "customer.csm",
    label: "CSM",
    description: "Customer success manager (e.g., Jacob Perry).",
    resolve: (c) =>
      c.customer_success_manager?.replace(/_/g, " ") ?? "your CSM",
  },
  {
    token: "customer.arr",
    label: "ARR",
    description: "Annual recurring revenue, currency-formatted.",
    resolve: (c) => fmtCurrency(c.arr),
  },
  {
    token: "customer.mrr",
    label: "MRR",
    description: "Monthly recurring revenue, currency-formatted.",
    resolve: (c) => fmtCurrency(c.mrr),
  },
  {
    token: "customer.subs",
    label: "Active subscribers",
    description: "Number of active subscribers.",
    resolve: (c) => fmtNumber(c.active_subs),
  },
  {
    token: "customer.tier",
    label: "Subscriber tier (cap)",
    description: "Max subscribers on their current plan.",
    resolve: (c) => fmtNumber(c.max_subscriptions),
  },
  {
    token: "customer.tier_pct",
    label: "% of subscriber tier",
    description: "Percent of max subs in use.",
    resolve: (c) => pct(c.percent_of_max_subs),
  },
  {
    token: "customer.plan",
    label: "Plan",
    description: "Stripe plan name.",
    resolve: (c) => c.stripe_plan ?? "—",
  },
  {
    token: "customer.last_send",
    label: "Last send",
    description: "Date the customer most recently sent a newsletter.",
    resolve: (c) => fmtDate(c.last_send),
  },
  {
    token: "customer.last_login",
    label: "Last login",
    description: "Most recent login (q10600 only populates within 14d).",
    resolve: (c) => fmtDate(c.last_log_in),
  },
  {
    token: "customer.last_contacted",
    label: "Last contacted",
    description:
      "Most-recent activity across any HubSpot contact at this company " +
      "(emails / calls / meetings / notes). Falls back to the legacy " +
      "notes_last_contacted field when HubSpot enrichment isn't available.",
    resolve: (c) => fmtDate(lastContacted(c).date),
  },
  {
    token: "customer.next_charge",
    label: "Next charge / renewal",
    description: "next_invoice from Stripe, or contract renewal date.",
    resolve: (c) => fmtDate(c.next_invoice ?? c.renewal_date),
  },
  {
    token: "customer.risk_level",
    label: "Risk level",
    description: "CSM-set HubSpot risk level (Yellow / Red / Light Green).",
    resolve: (c) => c.property_risk_level ?? "—",
  },
  {
    token: "customer.risk_detail",
    label: "Risk detail",
    description: "Free-text reason from HubSpot risk_level_detail.",
    resolve: (c) => c.property_risk_level_detail ?? "",
  },
  {
    token: "customer.goal",
    label: "Customer goal",
    description: "HubSpot customer_goals_csm property.",
    resolve: (c) => c.property_customer_goals ?? "",
  },

  // ─── Enterprise tier ladder (editable on /tiers) ──────────────────
  {
    token: "customer.current_tier",
    label: "Current tier",
    description:
      "The customer's current Enterprise tier formatted as 'subs / price' (price honors their billing cadence).",
    resolve: tierResolver((c, ladder) => {
      const t = findCurrentTier(c, ladder);
      return t ? fmtTier(t, c) : null;
    }),
  },
  {
    token: "customer.current_tier_subs",
    label: "Current tier — subs",
    description: "Tier name (subscriber bucket), e.g. '500K'.",
    resolve: tierResolver(
      (c, ladder) => findCurrentTier(c, ladder)?.name ?? null
    ),
  },
  {
    token: "customer.current_tier_price",
    label: "Current tier — price",
    description:
      "Tier price formatted with cadence (e.g. '$50K/yr' or '$5K/mo').",
    resolve: tierResolver((c, ladder) => {
      const t = findCurrentTier(c, ladder);
      return t ? fmtTierPrice(t, c) : null;
    }),
  },
  {
    token: "customer.next_tier_1",
    label: "Next tier — full",
    description: "First tier above the current — 'subs / price' format.",
    resolve: tierResolver(nthNextTier(0)),
  },
  {
    token: "customer.next_tier_1_subs",
    label: "Next tier — subs",
    description: "First-up tier subscriber name (e.g. '1M').",
    resolve: tierResolver(nthNextTierSubs(0)),
  },
  {
    token: "customer.next_tier_1_price",
    label: "Next tier — price",
    description: "First-up tier price.",
    resolve: tierResolver(nthNextTierPrice(0)),
  },
  {
    token: "customer.next_tier_2",
    label: "Tier +2",
    description: "Two tiers above the current.",
    resolve: tierResolver(nthNextTier(1)),
  },
  {
    token: "customer.next_tier_2_subs",
    label: "Tier +2 — subs",
    description: "Two-up tier subscriber name.",
    resolve: tierResolver(nthNextTierSubs(1)),
  },
  {
    token: "customer.next_tier_2_price",
    label: "Tier +2 — price",
    description: "Two-up tier price.",
    resolve: tierResolver(nthNextTierPrice(1)),
  },
  {
    token: "customer.next_tier_3",
    label: "Tier +3",
    description: "Three tiers above the current.",
    resolve: tierResolver(nthNextTier(2)),
  },
  {
    token: "customer.next_tier_3_subs",
    label: "Tier +3 — subs",
    description: "Three-up tier subscriber name.",
    resolve: tierResolver(nthNextTierSubs(2)),
  },
  {
    token: "customer.next_tier_3_price",
    label: "Tier +3 — price",
    description: "Three-up tier price.",
    resolve: tierResolver(nthNextTierPrice(2)),
  },
  {
    token: "customer.tier_ladder_html",
    label: "Tier ladder (HTML <ul>)",
    description:
      "HTML list of the next 3 tiers above the customer — drop into the rich-text body.",
    resolve: tierResolver((c, ladder) =>
      fmtTierLadderHtml(nextTiers(c, ladder, 3), c)
    ),
  },
  {
    token: "customer.tier_ladder_text",
    label: "Tier ladder (plain text)",
    description: "Bullet list of the next 3 tiers, rendered as plain text.",
    resolve: tierResolver((c, ladder) =>
      fmtTierLadderText(nextTiers(c, ladder, 3), c)
    ),
  },

  // ─── Ad network revenue (last 90d window) ─────────────────────────
  // These resolve when the caller passes `ctx.adGap`. The OutreachModal
  // does this for single-customer drafts; bulk paths leave them as "—".
  {
    token: "customer.ad_revenue_actual",
    label: "Ad network — actual revenue (90d)",
    description: "Sum of approved disbursements over the last 90 days.",
    resolve: (_, ctx) =>
      ctx.adGap ? fmtCurrency(ctx.adGap.portfolio_actual_dollars) : "—",
  },
  {
    token: "customer.ad_revenue_potential",
    label: "Ad network — potential at 100% fill",
    description:
      "Estimate of revenue if every missed-ad opportunity had filled at the customer's average per-ad rate.",
    resolve: (_, ctx) =>
      ctx.adGap
        ? fmtCurrency(ctx.adGap.portfolio_potential_at_full_fill_dollars)
        : "—",
  },
  {
    token: "customer.ad_revenue_gap",
    label: "Ad network — revenue gap",
    description:
      "Potential at 100% fill minus actual revenue — what they're leaving on the table.",
    resolve: (_, ctx) => {
      if (!ctx.adGap) return "—";
      const gap = Math.max(
        0,
        ctx.adGap.portfolio_potential_at_full_fill_dollars -
          ctx.adGap.portfolio_actual_dollars
      );
      return fmtCurrency(gap);
    },
  },
  {
    token: "customer.ad_zero_pubs",
    label: "Ad network — zero-ad publications",
    description:
      "Count of publications that are actively sending but have run zero ads in the period.",
    resolve: (_, ctx) =>
      ctx.adGap ? String(ctx.adGap.zero_ad_sending_pubs.length) : "—",
  },
];

const TAG_INDEX = new Map(MERGE_TAGS.map((t) => [t.token, t]));

/**
 * Replace every `{{token}}` (whitespace-tolerant) with the resolved value.
 * Unknown tokens are left as-is so the user can see them in the preview.
 *
 * Pass `ctx.ladder` from any caller that wants tier-aware tags to resolve.
 */
export function applyMergeTags(
  template: string,
  customer: Customer,
  ctx: MergeContext = {}
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, token) => {
    const tag = TAG_INDEX.get(token);
    return tag ? tag.resolve(customer, ctx) : match;
  });
}

export function isKnownTag(token: string): boolean {
  return TAG_INDEX.has(token);
}
